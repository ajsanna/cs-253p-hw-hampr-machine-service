import { DataCache } from "../database/cache";
import { MachineStateTable } from "../database/table";
import { IdentityProviderClient } from "../external/idp";
import { SmartMachineClient } from "../external/smart-machine";
import { GetMachineRequestModel, HttpResponseCode, MachineResponseModel, RequestMachineRequestModel, RequestModel, StartMachineRequestModel } from "./model";
import { MachineStateDocument, MachineStatus } from "../database/schema";

/**
 * Handles API requests for machine operations.
 * This class is responsible for routing requests to the appropriate handlers
 * and managing the overall workflow of machine interactions.
 */
export class ApiHandler {
    private cache: DataCache<MachineStateDocument>;
    private db: MachineStateTable;
    private idp: IdentityProviderClient;
    private smartMachine: SmartMachineClient;

    constructor() {
        this.cache = DataCache.getInstance<MachineStateDocument>();
        this.db = MachineStateTable.getInstance();
        this.idp = IdentityProviderClient.getInstance();
        this.smartMachine = SmartMachineClient.getInstance();
    }

    /**
     * Validates an authentication token.
     * @param token The token to validate.
     * @throws An error if the token is invalid.
     */
    private checkToken(token: string) {
        if (!this.idp.validateToken(token)) {
            throw new Error(JSON.stringify({
                statusCode: HttpResponseCode.UNAUTHORIZED,
                message: "Invalid token"
            }));
        }
    }

    /**
     * Handles a request to find and reserve an available machine at a specific location.
     * It finds an available machine, updates its status to AWAITING_DROPOFF,
     * assigns the job ID, and caches the updated machine state.
     * NOTE: The current implementation assumes a machine will be held for a certain period,
     * but there is no mechanism to release the hold if the user doesn't proceed.
     * @param request The request model containing location and job IDs.
     * @returns A response model with the status code and the reserved machine's state.
     */
    private handleRequestMachine(request: RequestMachineRequestModel): MachineResponseModel {
        try {
            const machines = this.db.listMachinesAtLocation(request.locationId);
            
            // Find an available machine
            const availableMachine = machines.find(m => m.status === MachineStatus.AVAILABLE);
            
            if (!availableMachine) {
                return {
                    statusCode: HttpResponseCode.NOT_FOUND,
                    machine: undefined
                };
            }

            // Update machine status to AWAITING_DROPOFF
            this.db.updateMachineStatus(availableMachine.machineId, MachineStatus.AWAITING_DROPOFF);
            
            // Assign the job ID
            this.db.updateMachineJobId(availableMachine.machineId, request.jobId);
            
            // Fetch the updated machine state
            const updatedMachine = this.db.getMachine(availableMachine.machineId);
            
            if (updatedMachine) {
                // Cache the machine state
                this.cache.put(availableMachine.machineId, updatedMachine);
                
                return {
                    statusCode: HttpResponseCode.OK,
                    machine: updatedMachine
                };
            }

            return {
                statusCode: HttpResponseCode.INTERNAL_SERVER_ERROR,
                machine: undefined
            };
        } catch (error) {
            return {
                statusCode: HttpResponseCode.INTERNAL_SERVER_ERROR,
                machine: undefined
            };
        }
    }

    /**
     * Retrieves the state of a specific machine.
     * It first checks the cache for the machine's data and, if not found, fetches it from the database.
     * @param request The request model containing the machine ID.
     * @returns A response model with the status code and the machine's state.
     */
    private handleGetMachine(request: GetMachineRequestModel): MachineResponseModel {
        try {
            // Check cache first
            const cachedMachine = this.cache.get(request.machineId);
            
            if (cachedMachine) {
                return {
                    statusCode: HttpResponseCode.OK,
                    machine: cachedMachine
                };
            }

            // Fetch from database if not in cache
            const machine = this.db.getMachine(request.machineId);
            
            if (!machine) {
                return {
                    statusCode: HttpResponseCode.NOT_FOUND,
                    machine: undefined
                };
            }

            // Cache the machine state for future requests
            this.cache.put(request.machineId, machine);
            
            return {
                statusCode: HttpResponseCode.OK,
                machine: machine
            };
        } catch (error) {
            return {
                statusCode: HttpResponseCode.INTERNAL_SERVER_ERROR,
                machine: undefined
            };
        }
    }

    /**
     * Starts the cycle of a machine that is awaiting drop-off.
     * It validates the machine's status, calls the external Smart Machine API to start the cycle,
     * and updates the machine's status to RUNNING.
     * @param request The request model containing the machine ID.
     * @returns A response model with the status code and the updated machine's state.
     */
    private handleStartMachine(request: StartMachineRequestModel): MachineResponseModel {
        try {
            // Fetch the machine state
            const machine = this.db.getMachine(request.machineId);
            
            if (!machine) {
                return {
                    statusCode: HttpResponseCode.NOT_FOUND,
                    machine: undefined
                };
            }

            // Validate that the machine is in AWAITING_DROPOFF status
            if (machine.status !== MachineStatus.AWAITING_DROPOFF) {
                return {
                    statusCode: HttpResponseCode.BAD_REQUEST,
                    machine: machine
                };
            }

            // Call the Smart Machine API to start the cycle
            this.smartMachine.startCycle(request.machineId);
            
            // Update the machine status to RUNNING
            this.db.updateMachineStatus(request.machineId, MachineStatus.RUNNING);
            
            // Fetch the updated machine state
            const updatedMachine = this.db.getMachine(request.machineId);
            
            if (updatedMachine) {
                // Update cache with new state
                this.cache.put(request.machineId, updatedMachine);
                
                return {
                    statusCode: HttpResponseCode.OK,
                    machine: updatedMachine
                };
            }

            return {
                statusCode: HttpResponseCode.INTERNAL_SERVER_ERROR,
                machine: undefined
            };
        } catch (error) {
            // Check if this is a hardware error (machine in ERROR status)
            try {
                const machine = this.db.getMachine(request.machineId);
                if (machine && machine.status === MachineStatus.ERROR) {
                    // Update the database to reflect the error status
                    this.db.updateMachineStatus(request.machineId, MachineStatus.ERROR);
                    // Update cache with error state
                    this.cache.put(request.machineId, machine);
                    return {
                        statusCode: HttpResponseCode.HARDWARE_ERROR,
                        machine: machine
                    };
                }
            } catch (innerError) {
                // Ignore inner error and return generic server error
            }
            
            return {
                statusCode: HttpResponseCode.INTERNAL_SERVER_ERROR,
                machine: undefined
            };
        }
    }

    /**
     * The main entry point for handling all API requests.
     * It validates the token and routes the request to the appropriate private handler based on the method and path.
     * @param request The incoming request model.
     * @returns A response model from one of the specific handlers, or an error response.
     */
    public handle(request: RequestModel) {
        this.checkToken(request.token);

        if (request.method === 'POST' && request.path === '/machine/request') {
            return this.handleRequestMachine(request as RequestMachineRequestModel);
        }

        const getMachineMatch = request.path.match(/^\/machine\/([a-zA-Z0-9-]+)$/);
        if (request.method === 'GET' && getMachineMatch) {
            const machineId = getMachineMatch[1];
            const getRequest = { ...request, machineId } as GetMachineRequestModel;
            return this.handleGetMachine(getRequest);
        }

        const startMachineMatch = request.path.match(/^\/machine\/([a-zA-Z0-9-]+)\/start$/);
        if (request.method === 'POST' && startMachineMatch) { 
            const machineId = startMachineMatch[1];
            const startRequest = { ...request, machineId } as StartMachineRequestModel;
            return this.handleStartMachine(startRequest);
        }

        return { statusCode: HttpResponseCode.INTERNAL_SERVER_ERROR, machine: undefined };
    }
}