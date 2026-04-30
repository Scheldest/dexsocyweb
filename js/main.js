async function showView(viewName) {
    if (!VIEW_ORDER.includes(viewName)) return;

    if (viewName !== "remote" && state.stream.active) {
        await StreamManager.stop("view-change", false);
    }

    if (viewName !== "devices" && !selectedDeviceReady()) {
        viewName = "devices";
    }

    setState({ ui: { view: viewName } });
}
