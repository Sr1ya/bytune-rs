import { installBridge } from "./shared/api";

// Must run before any module reads window.bytune (imports are evaluated in order).
installBridge();
