const AuthService = {
    watcher: null,

    async init() {
        const session = await safeQuery("session", () => supabaseClient.auth.getSession(), { silent: true });
        await this.applyUser(session?.data?.session?.user ?? null);
        if (!this.watcher) {
            const { data } = supabaseClient.auth.onAuthStateChange(async (_event, sessionValue) => {
                await this.applyUser(sessionValue?.user ?? null);
            });
            this.watcher = data;
        }
    },

    async applyUser(user) {
        let role = "user";
        let isAdmin = false;
        let user_id = null;

        if (user) {
            isAdmin = ADMIN_EMAILS.includes(user.email);
            // Fetch profile for role and user_id
            const { data: profile } = await supabaseClient.from("profiles").select("role, user_id").eq("id", user.id).single();
            if (profile) {
                role = profile.role;
                user_id = profile.user_id;
                if (role === "admin") isAdmin = true;
            }
        }

        setState({
            auth: {
                user,
                role,
                isAdmin,
                user_id
            }
        });
    },

    async signIn(email, password) {
        if (!email || !password) return;
        showLoader(true);
        try {
            const result = await safeQuery("sign in", () => supabaseClient.auth.signInWithPassword({ email, password }));
            if (result?.data?.user) {
                addLogEntry(`Signed in as ${email}`);
                await DeviceService.init();
                showView("devices");
            }
        } finally {
            showLoader(false);
        }
    },

    async signOut() {
        try {
            await StreamManager.stop("signout", false);
            DeviceService.shutdown();
            showLoader(true);
            await safeQuery("sign out", () => supabaseClient.auth.signOut(), { silent: true });
        } finally {
            showLoader(false);
            // Reset full state to defaults
            state.auth = { user: null, isAdmin: false };
            state.ui = { view: "devices", modal: null, toasts: [], logs: [] };
            state.data = { devices: [], selectedDeviceId: null, selectedDevice: null, controlStatesByDevice: {} };
            state.stream = { active: false, mode: null, token: state.stream.token + 1, status: "idle", withAudio: false };
            UI.render();
        }
    }
};

