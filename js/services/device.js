const DeviceService = {
    fleetChannel: null,
    deviceChannel: null,

    async init() {
        await this.refresh();
        this.bindFleet();
        if (state.data.selectedDeviceId) {
            await this.select(state.data.selectedDeviceId, true);
        }
    },

    shutdown() {
        if (this.fleetChannel) {
            supabaseClient.removeChannel(this.fleetChannel);
            this.fleetChannel = null;
        }
        if (this.deviceChannel) {
            supabaseClient.removeChannel(this.deviceChannel);
            this.deviceChannel = null;
        }
    },

    bindFleet() {
        if (this.fleetChannel) supabaseClient.removeChannel(this.fleetChannel);
        this.fleetChannel = supabaseClient
            .channel("devices_changes_minimal")
            .on("postgres_changes", { event: "*", schema: "public", table: "devices" }, async () => {
                await this.refresh();
            })
            .subscribe();
    },

    bindDevice(deviceId) {
        if (this.deviceChannel) supabaseClient.removeChannel(this.deviceChannel);
        this.deviceChannel = supabaseClient
            .channel(`device:${deviceId}:minimal`)
            .on("postgres_changes", {
                event: "INSERT",
                schema: "public",
                table: "device_data",
                filter: `device_id=eq.${deviceId}`
            }, (payload) => {
                this.handleDeviceData(payload.new);
            })
            .on("postgres_changes", {
                event: "UPDATE",
                schema: "public",
                table: "devices",
                filter: `id=eq.${deviceId}`
            }, async (payload) => {
                const updatedDevice = payload.new;
                setState({ data: { selectedDevice: updatedDevice } });

                // Also update in the devices list
                const updatedDevices = state.data.devices.map(d => d.id === updatedDevice.id ? updatedDevice : d);
                setState({ data: { devices: updatedDevices } });
            })
            .subscribe();
    },

    clearSelection() {
        if (this.deviceChannel) {
            supabaseClient.removeChannel(this.deviceChannel);
            this.deviceChannel = null;
        }

        addLogEntry("Returned to device selection", "muted");

        setState({
            data: {
                selectedDeviceId: null,
                selectedDevice: null
            },
            ui: {
                view: "devices"
            }
        });
    },

    setToggleState(toggleKey, nextValue) {
        const deviceId = state.data.selectedDeviceId;
        const toggle = getToggleConfig(toggleKey);
        if (!deviceId || !toggle) return;

        const currentDeviceStates = state.data.controlStatesByDevice[deviceId] || {};
        setState({
            data: {
                controlStatesByDevice: {
                    ...state.data.controlStatesByDevice,
                    [deviceId]: {
                        ...currentDeviceStates,
                        [toggle.stateKey]: nextValue
                    }
                }
            }
        });
    },

    canAccess(device) {
        if (!device) return false;
        if (state.auth.isAdmin) return true;

        // Match device user_id with current user's user_id from profile
        const userProfileId = state.auth.user_id;
        return device.user_id === userProfileId;
    },

    async refresh() {
        try {
            const result = await safeQuery("devices", () => supabaseClient.from("devices").select("*"));
            if (!result?.data) return;

            const devices = [...result.data].sort((a, b) => {
                return (a.name || "").localeCompare(b.name || "") || a.id.localeCompare(b.id);
            });

            const selectedDevice = devices.find((device) => device.id === state.data.selectedDeviceId) || null;
            if (state.data.selectedDeviceId && !selectedDevice) {
                await StreamManager.stop("device-missing", false);
                setState({
                    data: {
                        devices,
                        selectedDeviceId: null,
                        selectedDevice: null
                    },
                    ui: {
                        view: "devices"
                    }
                });
                return;
            }

            setState({ data: { devices, selectedDevice } });
        } catch (e) {
            console.error("Refresh failed", e);
        }
    },

    async select(deviceId, force = false) {
        if (!deviceId) return;

        let device = state.data.devices.find((item) => item.id === deviceId) || null;
        if (!device) {
            await this.refresh();
            device = state.data.devices.find((item) => item.id === deviceId) || null;
        }

        if (!device) {
            addToast("Device not found", "error");
            return;
        }

        if (!this.canAccess(device)) {
            addToast("Access denied", "error");
            return;
        }

        if (deviceId === state.data.selectedDeviceId && !force) {
            await showView("remote");
            return;
        }

        await StreamManager.stop("device-switch", false);
        showLoader(true);
        setState({ data: { selectedDevice: device, selectedDeviceId: deviceId } });

        try {
            const { data: deviceData } = await safeQuery("Fetch Device", () =>
                supabaseClient.from("devices").select("*").eq("id", deviceId).maybeSingle()
            );

            if (deviceData) {
                setState({ data: { selectedDevice: deviceData } });
                this.bindDevice(deviceId);
                addLogEntry(`Connection established: ${deviceData.name || deviceId}`);
                await showView("remote");
            } else {
                throw new Error("Device data not reachable");
            }
        } catch (err) {
            addToast("Failed to sync with device", "error");
            this.clearSelection();
        } finally {
            showLoader(false);
        }
    },

    async refreshSelected() {
        if (!state.data.selectedDeviceId) return;
        showLoader(true);
        try {
            const { data } = await supabaseClient.from("devices").select("*").eq("id", state.data.selectedDeviceId).maybeSingle();
            if (data) {
                setState({ data: { selectedDevice: data } });
                await this.refresh();
            }
        } finally {
            showLoader(false);
        }
    },

    async send(command, { silent = false, showSuccess = false } = {}) {
        const deviceId = state.data.selectedDeviceId;
        const device = state.data.selectedDevice;

        if (!deviceId || !device) {
            if (!silent) addToast("No device selected", "error");
            return { success: false, error: "no_device" };
        }

        if (!isOnline(device)) {
            if (!silent) addToast("Device is offline", "error");
            return { success: false, error: "offline" };
        }

        if (this._lastCommandTime && Date.now() - this._lastCommandTime < 400) {
            if (!silent) addToast("Please wait...", "warning");
            return { success: false, error: "debounce" };
        }
        this._lastCommandTime = Date.now();

        const cleanCommand = command.trim();
        const result = await safeQuery("command", () =>
            supabaseClient.from("commands").insert([{
                device_id: deviceId,
                cmd: cleanCommand,
                created_at: new Date().toISOString()
            }]), { silent: true }
        );

        if (!result || result.success === false) {
            if (!silent) addToast("Command failed to sync", "error");
            return { success: false, error: result?.error || "sync_failed" };
        }

        if (showSuccess) {
            const rawCmd = cleanCommand.split(':')[0].split('_')[0];
            const readableCmd = rawCmd.charAt(0).toUpperCase() + rawCmd.slice(1);
            addToast(`Sent: ${readableCmd}`);
        }

        if (!silent) {
            let logCmd = cleanCommand;
            if (cleanCommand.startsWith(CMD.LOAD_MODULE)) {
                logCmd = `${CMD.LOAD_MODULE}:[PAYLOAD_URL]:[CLASS_NAME]`;
            }
            addLogEntry(`> Sending: ${logCmd}`, "muted");
        }
        return { success: true };
    },

    handleDeviceData(row) {
        const type = row?.data_type;
        const content = row?.content;

        // Route logs and errors to injection UI if active
        if (state.ui.modal?.type === "injection") {
            if (["injection_log", "log", "error"].includes(type)) {
                UI.updateInjectionLog(content);
                return;
            }
        }

        if (type === "injection_log") {
            UI.updateInjectionLog(content);
            return;
        }

        if (type === "log" || type === "error") {
            addLogEntry(content, type === "error" ? "error" : "normal");
            return;
        }

        if (type === "image" || type === "camera" || type === "screenshot") {
            addLogEntry("Media received from device");
            // Check if content is a raw base64 and ensure it has the correct prefix
            let src = content;
            if (content && !content.startsWith("data:") && !content.startsWith("http")) {
                src = `data:image/jpeg;base64,${content}`;
            }
            UI.openImage(src);
            return;
        }

        if (type === "location") {
            addLogEntry("Location received from device");
            const loc = safeParseJSON(content);
            if (loc && (loc.lat || loc.latitude)) {
                UI.openLocation(loc);
            } else {
                addToast("Bad location data", "error");
            }
            return;
        }

        if (type === "sms") {
            addLogEntry("Text messages received from device");
            const sms = safeParseJSON(content, []);
            UI.openSms(sms);
        }
    }
};
