document.addEventListener("DOMContentLoaded", async () => {
    UI.init();
    await AuthService.init();

    if (state.auth.user) {
        showLoader(true);
        await DeviceService.init();
        showLoader(false);
    }

    supabaseClient.auth.onAuthStateChange(async (_event, session) => {
        if (session?.user) return;
        DeviceService.shutdown();
        await StreamManager.stop("logout", false);
        setState({
            data: {
                devices: [],
                selectedDeviceId: null,
                selectedDevice: null,
                controlStatesByDevice: {}
            },
            ui: {
                view: "devices",
                modal: null,
                logs: []
            }
        });
    });
});
