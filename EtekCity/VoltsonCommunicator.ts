import {
    IDCHTTPCommand,
    HTTPCommand,
    EndpointCommunicator,
    IEndpointCommunicatorConfig
} from "@devctrl/lib-communicator";
import {
    Control,
    ControlUpdateData,
    IEndpointStatus,
    IndexedDataSet
} from "@devctrl/common";
import * as https from "https";
import * as crypto from "crypto";
import { Subject } from 'rxjs';

export interface IVeSyncDeviceDef {
    cid: string;
    deviceName: string;
    deviceImg: string;
    deviceStatus: string;
    deviceType: string;
    model: string;
    currentFirmware: string;
    connectionType: string;
    connectionStatus: string;


}

export class VoltsonCommunicator extends EndpointCommunicator {
    commands: IndexedDataSet<IDCHTTPCommand> = {};
    commandsByTemplate: IndexedDataSet<IDCHTTPCommand> = {};
    pollTimer;
    endpointPassword = "mynWeck1";
    endpointUser = "verk1201@gmail.com";
    account = {};
    devices: IVeSyncDeviceDef[] = [];

    constructor(config: IEndpointCommunicatorConfig) {
        super(config);
    }

    async buildCommandList() : Promise<void> {
        let initProc = new Subject<void>();
        let waitProcs$ = initProc.asObservable();

        // Query the API server for a list of devices
        let hash = crypto.createHash('md5').update(this.endpointPassword).digest('hex');

        let userData = {
            account: this.endpointUser,
            devToken: "",
            password: hash
        };

        let accountReq = https.request({
            hostname: this.config.endpoint.address,
            port: this.config.endpoint.port,
            path: '/vold/user/login',
            method: 'POST'
        }, (res) => {
            if (res.statusCode !== 200) {
                this.log("login request: invalid status code response: " + res.statusCode);
            }
            else {
                this.log(`user data successfully queried`);
            }

            res.setEncoding('utf8');
            let body ='';
            res.on('data', (chunk) => { body += chunk});
            res.on('end', () => {
                this.log(`account request completed: ${body}`);
                this.account = JSON.parse(body);
                initProc.complete();
            });

        })
            .on('error', (e) => {
                this.log(`Error on query: ${e.message}`);
                this.closeConnection();
            });

        let payload = JSON.stringify(userData);
        this.log("vesync login payload:" + payload);
        accountReq.write(payload);
        accountReq.end();

        await waitProcs$.toPromise();

        this.log("account request complete");

        let devicesProc = new Subject<void>();
        let devicesProc$ = devicesProc.toPromise();

        let deviceReq = https.request({
            hostname: this.config.endpoint.address,
            port: this.config.endpoint.port,
            path: '/vold/user/devices',
            method: 'GET',
            headers: this.requestHeaders()
        }, (res) => {
            if (res.statusCode !== 200) {
                this.log("devices request: invalid status code response: " + res.statusCode);
            }
            else {
                this.log(`device data successfully queried`);
            }

            res.setEncoding('utf8');
            let body ='';
            res.on('data', (chunk) => { body += chunk});
            res.on('end', () => {
                this.log(`devices request completed: ${body}`);
                this.devices = JSON.parse(body);
                devicesProc.complete();
            });

        })
            .on('error', (e) => {
                this.log(`Error on query: ${e.message}`);
                this.closeConnection();
            });
        deviceReq.end();

        await devicesProc$;
        this.log("devices request completed");

        for (let device of this.devices) {
            this.registerPowerCommand(device.cid, device.deviceName);
        }
    }

    registerPowerCommand(chanId, chanName) {
        let ctid = this.endpoint_id + `power-${chanId}`;
        this.commands[ctid] = new HTTPCommand(
            {
                name: chanName,
                cmdPathFunction: (val) => {
                    let enabled = val ? "on" : "off";
                    return `/v1/wifi-switch-1.3/${chanId}/status/${enabled}`;
                },
                cmdResponseRE: "",
                cmdQueryPath: "/vold/user/devices",
                cmdQueryResponseParseFn: (control, data) => {
                    let arr;
                    try {
                        arr = <IVeSyncDeviceDef[]>JSON.parse(data);
                    }
                    catch (e) {
                        this.log(`JSON parse error for data: ${data}`);
                        return;
                    }

                    for (let dev of arr) {
                        if (dev.cid === chanId) {
                            return dev.deviceStatus === "on";
                        }
                    }
                },
                updateMethod: "PUT",
                controlData: {
                    _id: ctid,
                    ctid: ctid,
                    endpoint_id: this.endpoint_id,
                    usertype: Control.USERTYPE_SWITCH,
                    name: chanName,
                    control_type: Control.CONTROL_TYPE_BOOLEAN,
                    poll: 1,
                    ephemeral: false,
                    config: {},
                    value: false
                }
            }
        )
    }

    requestHeaders() {
        return {
            tk: this.account['tk'],
            accountid: this.account['accountID']
        };
    }

    closeConnection() {
        // Not really much to do here, no persistent connection is maintained
        this.updateStatus({
            polling: false,
            responsive: false
        });

    };

    executeCommandQuery(cmd: IDCHTTPCommand) {
        if (cmd.writeonly) {
            this.log(`not querying writeonly command ${cmd.name}`, EndpointCommunicator.LOG_POLLING);
        }

        let requestPath = "https://" + this.config.endpoint.address + cmd.queryString();
        this.log("sending request:" + requestPath, EndpointCommunicator.LOG_RAW_DATA);

        let req = https.request({
            hostname: this.config.endpoint.address,
            port: this.config.endpoint.port,
            path: cmd.queryString(),
            method: cmd.queryMethod,
            headers: this.requestHeaders()
        }, (res) => {
            if (res.statusCode !== 200) {
                this.log("invalid status code response: " + res.statusCode);
            }
            else {
                this.log(`cmd ${cmd.name} successfully queried`);
                res.setEncoding('utf8');
                let body ='';
                res.on('data', (chunk) => { body += chunk});
                res.on('end', () => {
                    for (let ctid of cmd.ctidList) {
                        let control = this.controlsByCtid[ctid];
                        let val = cmd.parseQueryResponse(control, body);
                        if (typeof val !== 'undefined') {
                            this.log(`${cmd.name} response parsed: ${body},${val}`, EndpointCommunicator.LOG_MATCHING);
                            this.setControlValue(control, val);
                            this.connectionConfirmed();
                        }
                        else {
                            this.log(`${cmd.name} update response did not match: ${body}`, EndpointCommunicator.LOG_MATCHING);
                        }
                    }
                });
            }
        })
            .on('error', (e) => {
                this.log(`Error on query: ${e.message}`);
                this.closeConnection();
            });
        req.end();
    }

    async getControlTemplates() : Promise<IndexedDataSet<Control>> {
        await this.buildCommandList();

        for (let cmd in this.commands) {
            let controls = this.commands[cmd].getControlTemplates();

            for (let control of controls) {
                this.controlsByCtid[control.ctid] = control;
                this.commandsByTemplate[control.ctid] = this.commands[cmd];
            }
        }

        return this.controlsByCtid;
    }

    /**
     * Process a ControlUpdate, likely by sending a command to
     * a device
     * @param update ControlUpdateData The request control update
     */
    handleControlUpdateRequest(update: ControlUpdateData) {
        let control = this.controls[update.control_id];
        let command = this.commandsByTemplate[control.ctid];

        if (! command) {
            this.log(`No command found for control ${control.name}`);
            return;
        }

        let requestPath = "https://" + this.config.endpoint.address + command.updateString(control, update.value);
        this.log("sending request:" + requestPath, EndpointCommunicator.LOG_RAW_DATA);

        let req = https.get({
            hostname: this.config.endpoint.address,
            port: this.config.endpoint.port,
            path: command.updateString(control, update.value),
            method: command.updateMethod,
            headers: this.requestHeaders()
        }, (res) => {
            if (res.statusCode !== 200) {
                this.log("invalid status code response: " + res.statusCode);
            }

            //debug(`${command.name} set to ${update.value} successfully`);
            res.setEncoding('utf8');
            let body ='';
            res.on('data', (chunk) => { body += chunk});
            res.on('end', () => {
                this.log(`update response: ${body}`, EndpointCommunicator.LOG_RAW_DATA);
                if (command.matchUpdateResponse(control, update, body)) {
                    let newVal = command.parseUpdateResponse(control, update, body);
                    this.log(`${control.name} response successful, value: ${newVal}`, EndpointCommunicator.LOG_UPDATES);
                    this.config.controlUpdateCallback(control, newVal);
                    this.connectionConfirmed();
                }
                else {
                    this.log(`${control.name} update response did not match: ${body}`, EndpointCommunicator.LOG_MATCHING);
                }
            });
        }).on('error', (e) => {
            this.log(`Error on update request: ${e.message}`);
            this.closeConnection();
        });

        req.end();
    }


    initStatus() {
        let es = this.epStatus;
        es.reachable = false;
        es.connected = false;
        es.loggedIn = false;
        es.polling = false;
        es.responsive = false;
        es.ok = false;
        this.config.statusUpdateCallback();
        this.launchPing();
    }

    online() {
        if (! this.monitorTimer) {
            this.monitorTimer = setInterval(()=> {
                let offset = Date.now() - this.lastConfirmedCommunication;

                if (offset > 30000) {
                    this.updateStatus({ responsive: false });
                }
            }, 30000);
        }



        if (! this.pollTimer) {
            this.pollTimer = setInterval(() => {
                this.poll();
            }, 10000);
        }

        this.updateStatus({
            polling: true
        });
    };


    poll() {
        if (! this.epStatus.polling) {
            return;
        }

        this.log("polling device", EndpointCommunicator.LOG_POLLING);

        for (let id in this.controls) {
            let control = this.controls[id];

            if (control.poll) {
                let cmd = this.commandsByTemplate[control.ctid];

                if (cmd) {
                    this.executeCommandQuery(cmd);
                }
                else {
                    this.log("command not found for poll control " + control.ctid);
                }
            }
        }
    }


    updateStatus(statusChanges: IEndpointStatus) {
        let statusDiff= this.config.endpoint.statusDiff(statusChanges);
        let statusUnchanged = this.config.endpoint.compareStatus(statusChanges);
        let es = this.epStatus;

        if (! (es === this.config.endpoint.epStatus)) {
            this.log("epStatus mismathc!!!", EndpointCommunicator.LOG_STATUS);
        }

        let diffStr = "";
        // Set the new values
        for (let f in statusDiff) {
            es[f] = statusDiff[f];
            diffStr += f;
            diffStr += " ";
        }

        // connected and loggedIn don't apply, they should always mirror polling
        es.connected = es.loggedIn = es.polling;
        es.ok = ( es.enabled && es.reachable && es.connected && es.loggedIn && es.polling && es.responsive);

        let statusStr = this.endpoint.statusStr;
        this.log("status update: " + statusStr, EndpointCommunicator.LOG_STATUS);

        if (! statusUnchanged) {
            //this.log("status diff: " + diffStr, EndpointCommunicator.LOG_STATUS);
            this.config.statusUpdateCallback();
        }


        // Figure out what to do next
        if (! es.enabled) {
            if (! es.reachable) {
                if (! es.connected) {
                    if (! es.loggedIn) {
                        if (! es.polling) {
                            if (!es.responsive) {
                                if (!es.ok) {
                                    // Stopped.  Nothing to do.
                                    return;
                                }
                                else {  // ok
                                    // We should never end up here. Fall through and throw error
                                }
                            }
                            else { // responsive
                                this.closeConnection();
                                return;
                            }
                        }
                        else { // polling
                            this.closeConnection();
                            return;
                        }
                    }
                    else { // loggedIn
                        this.closeConnection();
                        return;
                    }
                }
                else { // connected
                    this.closeConnection();
                    return;
                }
            }
            else { // reachable
                if (es.connected) {
                    this.closeConnection();
                    return;
                }
            }
        }
        else { // enabled
            if (! es.reachable) {
                // Enabled, not reachable, nothing to do
                return;
            }
            else { // reachable
                if (! es.polling) {
                    this.online();
                }
                else { // polling
                    if (! es.responsive) {
                        if (statusDiff.responsive === false) {
                            // Disconnect and attempt to reconnect
                            this.closeConnection();
                        }
                    }
                    else { // responsive
                        return;
                    }
                }
            }
        }

        // We'll only fall through to here in weird unhandled cases.
        //throw new Error("unhandled status update state");
    }

}