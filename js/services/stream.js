const StreamManager = {
    peer: null,
    signalChannel: null,
    timeoutId: null,
    audioNode: null,
    streamRef: null,
    isStopping: false,
    isStarting: false,
    remoteIceQueue: [],
    iceUpdateQueue: [], // Queue for outgoing web candidates

    async start(mode, isRefresh = false) {
        if (!state.data.selectedDeviceId) {
            addToast("No device", "error");
            return;
        }

        if (this.isStarting && !isRefresh) return;
        this.isStarting = true;

        const token = Date.now();
        this.isStopping = false;
        this.remoteIceQueue = [];
        this.iceUpdateQueue = [];
        this.streamRef = new MediaStream();

        // 1. Tampilkan modal loading SEGERA
        setState({
            stream: {
                ...state.stream,
                active: true,
                mode,
                token,
                status: "connecting"
            },
            ui: {
                modal: { type: "stream", mode }
            }
        });

        try {
            // 2. Bersihkan sesi lama jika ada
            if (this.peer || this.streamRef || isRefresh) {
                await this.stop(isRefresh ? "refresh" : "restart", false, true);
                await new Promise(r => setTimeout(r, 800));
            }

            let iceServers = [...RTC_CONFIG.iceServers];

            try {
                const { data: configData } = await supabaseClient.from("app_settings").select("value").eq("key", "streaming").maybeSingle();
                if (configData?.value) {
                    const settings = configData.value;
                    const response = await fetch(`https://dexsocy.metered.live/api/v1/turn/credentials?apiKey=${settings.api_key}`);
                    if (response.ok) {
                        const dynamicServers = await response.json();
                        iceServers = [...iceServers, ...dynamicServers];
                    } else {
                        throw new Error("API fail");
                    }
                } else {
                    iceServers = [...iceServers, ...FALLBACK_TURN];
                }
            } catch (e) {
                iceServers = [...iceServers, ...FALLBACK_TURN];
            }

            const peer = new RTCPeerConnection({ ...RTC_CONFIG, iceServers });
            this.peer = peer;

            this.timeoutId = window.setTimeout(async () => {
                if (state.stream.token === token && state.stream.status !== "connected") {
                    // Ensure isStarting is false so we can try again
                    this.isStarting = false;
                    await this.stop("timeout");
                }
            }, 30000);

            // --- SUBSCRIBE ---
            const processedDeviceCandidates = new Set();
            this.signalChannel = supabaseClient
                .channel(`signal:${state.data.selectedDeviceId}:${token}`)
                .on("postgres_changes", {
                    event: "UPDATE",
                    schema: "public",
                    table: "signaling",
                    filter: `device_id=eq.${state.data.selectedDeviceId}`
                }, async (payload) => {
                    if (state.stream.token !== token) return;
                    const next = payload.new;

                    if (next.answer && peer.signalingState === "have-local-offer") {
                        try {
                            await peer.setRemoteDescription(new RTCSessionDescription(JSON.parse(next.answer)));
                            this.drainIceQueue();
                        } catch (e) { }
                    }

                    if (next.candidates_dev?.length) {
                        for (const cand of next.candidates_dev) {
                            if (!processedDeviceCandidates.has(cand)) {
                                processedDeviceCandidates.add(cand);
                                try {
                                    if (peer.remoteDescription) await peer.addIceCandidate(new RTCIceCandidate(JSON.parse(cand)));
                                    else this.remoteIceQueue.push(cand);
                                } catch (e) { }
                            }
                        }
                    }
                })
                .subscribe(async (status) => {
                    if (status === "SUBSCRIBED") {
                        await this.createAndSendOffer(mode, token);
                    }
                });

            // ... (event handlers)
            peer.onconnectionstatechange = async () => {
                if (state.stream.token !== token) return;
                const s = peer.connectionState;

                setState({ stream: { status: s } });

                if (s === "connected") {
                    this.isStarting = false;
                    window.clearTimeout(this.timeoutId);
                    this.timeoutId = null;
                }

                if (["failed", "closed"].includes(s)) await this.stop(s);
            };

            peer.ontrack = (event) => {
                if (state.stream.token !== token) return;

                if (!this.streamRef) this.streamRef = new MediaStream();
                this.streamRef.addTrack(event.track);

                if (event.track.kind === "audio") this.attachAudio(this.streamRef);
                if (event.track.kind === "video") {
                    // Update status and clear timeout
                    setState({ stream: { status: "connected" } });
                    this.isStarting = false;
                    window.clearTimeout(this.timeoutId);
                    this.timeoutId = null;

                    this.reAttachVideo();
                }
            };

            const processedWebCandidates = new Set();
            peer.onicecandidate = async (event) => {
                if (!event.candidate || state.stream.token !== token) return;
                const candStr = JSON.stringify(event.candidate);
                if (processedWebCandidates.has(candStr)) return;
                processedWebCandidates.add(candStr);

                // Masukkan ke queue untuk dikirim satu per satu (mencegah race condition)
                this.iceUpdateQueue.push(JSON.parse(candStr));
                this.processIceQueue();
            };

        } catch (err) {
            this.isStarting = false;
            await this.stop("error");
        }
    },

    async processIceQueue() {
        if (this._isProcessingIce || this.iceUpdateQueue.length === 0) return;
        this._isProcessingIce = true;

        try {
            const toAdd = [...this.iceUpdateQueue];
            this.iceUpdateQueue = [];

            // Gunakan RPC jika ada, jika tidak gunakan patch dengan resiko race condition minimal karena queueing
            const { error } = await supabaseClient.rpc('append_web_candidate', {
                dev_id: state.data.selectedDeviceId,
                new_candidates: toAdd
            });

            if (error) {
                // Fallback jika RPC belum dibuat
                const { data } = await supabaseClient.from("signaling").select("candidates_web").eq("device_id", state.data.selectedDeviceId).maybeSingle();
                const updated = [...(data?.candidates_web || []), ...toAdd];
                await supabaseClient.from("signaling").update({ candidates_web: updated }).eq("device_id", state.data.selectedDeviceId);
            }
        } catch (e) { }

        this._isProcessingIce = false;
        if (this.iceUpdateQueue.length > 0) this.processIceQueue();
    },

    async createAndSendOffer(mode, token) {
        try {
            if (mode !== "audio") this.peer.addTransceiver("video", { direction: "recvonly" });
            this.peer.addTransceiver("audio", { direction: "recvonly" });

            const offer = await this.peer.createOffer({
                offerToReceiveAudio: true,
                offerToReceiveVideo: mode !== "audio"
            });

            if (state.stream.token !== token) return;
            await this.peer.setLocalDescription(offer);

            const signalType = state.stream.withAudio && mode !== "audio" ? `${mode}:audio` : mode;

            // Upsert will reset answer and candidates atomically with the new offer
            await safeQuery("signal", () =>
                supabaseClient.from("signaling").upsert({
                    device_id: state.data.selectedDeviceId,
                    type: signalType,
                    offer: JSON.stringify(offer),
                    answer: null,
                    candidates_web: [],
                    candidates_dev: [],
                    updated_at: new Date().toISOString()
                })
            );
            addLogEntry(`Started stream: ${mode}`);
        } catch (error) {
            await this.stop("error", false);
        }
    },

    async drainIceQueue() {
        while (this.remoteIceQueue.length > 0) {
            const cand = this.remoteIceQueue.shift();
            try {
                await this.peer.addIceCandidate(new RTCIceCandidate(JSON.parse(cand)));
            } catch (e) { }
        }
    },

    attachAudio(stream) {
        if (!this.audioNode) {
            this.audioNode = document.createElement("audio");
            this.audioNode.autoplay = true;
            this.audioNode.playsInline = true;
            this.audioNode.className = "hidden";
            document.body.appendChild(this.audioNode);
        }
        this.audioNode.srcObject = stream;
        this.audioNode.play().catch(e => { });
    },

    reAttachVideo() {
        if (state.stream.status !== "connected") return;
        const videoNode = document.getElementById("remoteVideo");
        if (videoNode && this.streamRef) {
            // Only attach if not already attached to avoid flicker
            if (videoNode.srcObject !== this.streamRef) {
                videoNode.srcObject = this.streamRef;
            }

            // Try to play immediately
            videoNode.play().catch(() => {
                // If failed (e.g. user interaction required), try again when metadata is loaded
                videoNode.onloadedmetadata = () => videoNode.play().catch(e => { });
            });
        }
    },

    async stop(reason = "manual", notify = true, skipStateUpdate = false) {
        if (this.isStopping && !["restart", "refresh", "timeout"].includes(reason)) return;
        if (reason !== "restart" && reason !== "refresh") this.isStopping = true;

        // Force reset starting flag whenever we stop
        this.isStarting = false;

        window.clearTimeout(this.timeoutId);
        this.timeoutId = null;

        if (this.signalChannel) {
            supabaseClient.removeChannel(this.signalChannel);
            this.signalChannel = null;
        }

        if (this.peer) {
            this.peer.ontrack = null;
            this.peer.onicecandidate = null;
            this.peer.onconnectionstatechange = null;
            this.peer.oniceconnectionstatechange = null;
            try {
                this.peer.getReceivers().forEach((receiver) => {
                    try { receiver.track?.stop(); } catch (e) {}
                });
                this.peer.getSenders().forEach((sender) => {
                    try { sender.track?.stop(); } catch (e) {}
                });
                this.peer.close();
            } catch (e) {}
            this.peer = null;
        }

        if (this.streamRef) {
            try {
                this.streamRef.getTracks().forEach((track) => track.stop());
            } catch (e) {}
            this.streamRef = null;
        }

        const remoteVideo = document.getElementById("remoteVideo");
        if (remoteVideo) {
            try {
                remoteVideo.pause();
                remoteVideo.srcObject = null;
                remoteVideo.load();
            } catch (e) {}
        }

        if (this.audioNode) {
            try {
                this.audioNode.pause();
                this.audioNode.srcObject = null;
            } catch (e) {}
        }

        const activeDeviceId = state.data.selectedDeviceId;
        if (activeDeviceId && !["signout", "logout", "restart", "refresh", "device-back"].includes(reason)) {
            try {
                // Signal "stop" to the device via signaling table
                await supabaseClient.from("signaling").upsert({
                    device_id: activeDeviceId,
                    type: "stop",
                    offer: null,
                    answer: null,
                    candidates_web: [],
                    candidates_dev: [],
                    updated_at: new Date().toISOString()
                });

                // Also send a direct command as backup
                await supabaseClient.from("commands").insert([{
                    device_id: activeDeviceId,
                    cmd: CMD.STOP_STREAM
                }]);
            } catch (e) {
            }
        }

        if (!skipStateUpdate) {
            setState({
                stream: {
                    active: false,
                    mode: null,
                    token: state.stream.token + 1,
                    status: "idle"
                },
                ui: {
                    modal: (reason === "restart" || reason === "refresh") ? state.ui.modal : null
                }
            });

            if (notify && !["restart", "refresh", "view-change", "device-switch", "signout", "timeout"].includes(reason)) {
                addToast(`Stream ${reason}`);
            } else if (reason === "timeout") {
                addToast("Stream connection timed out", "error");
            }
        }

        this.isStopping = false;
    }
};
