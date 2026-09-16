import UIKit
import Capacitor

// Registers the app's own plugin with the Capacitor bridge.
class TapTimeViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(TapTimeNativePlugin())
        #if DEBUG
        // Simulator automation: `-taptime-js-file <path>` runs a script in the
        // web view once the app has rendered (DEBUG builds only).
        if let path = DebugLaunch.value("-taptime-js-file"), let code = try? String(contentsOfFile: path, encoding: .utf8) {
            let delay = Double(DebugLaunch.value("-taptime-js-delay") ?? "3") ?? 3
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                self?.bridge?.webView?.evaluateJavaScript(code) { _, error in
                    if let error = error { print("⚡️  [debug-js] error: \(error.localizedDescription)") }
                }
            }
        }
        #endif
    }
}
