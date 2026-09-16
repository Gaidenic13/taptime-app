import Foundation
import Capacitor
import Security
#if canImport(CoreNFC)
import CoreNFC
#endif

// The app's only custom native surface:
//  · Keychain-backed values (device identity + session) — survive reinstalls,
//    can't be cleared like web storage, scoped to this app
//  · Core NFC foreground reading of the TapTime tag (NDEF URL record)
@objc(TapTimeNativePlugin)
public class TapTimeNativePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "TapTimeNativePlugin"
    public let jsName = "TapTimeNative"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getSecure", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setSecure", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "nfcAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "scanNfc", returnType: CAPPluginReturnPromise),
    ]
    private let service = "com.taptime.app"

    private func baseQuery(_ key: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: key]
    }

    @objc func getSecure(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else { call.reject("key required"); return }
        var query = baseQuery(key)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecSuccess, let data = item as? Data, let value = String(data: data, encoding: .utf8) {
            call.resolve(["value": value])
        } else {
            call.resolve([:])
        }
    }

    @objc func setSecure(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else { call.reject("key required"); return }
        let value = call.getString("value") ?? ""
        SecItemDelete(baseQuery(key) as CFDictionary)
        if !value.isEmpty, let data = value.data(using: .utf8) {
            var add = baseQuery(key)
            add[kSecValueData as String] = data
            add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            let status = SecItemAdd(add as CFDictionary, nil)
            if status != errSecSuccess { call.reject("Keychain write failed (\(status))"); return }
        }
        call.resolve()
    }

    @objc func nfcAvailable(_ call: CAPPluginCall) {
        #if canImport(CoreNFC)
        call.resolve(["available": NFCNDEFReaderSession.readingAvailable])
        #else
        call.resolve(["available": false])
        #endif
    }

    #if canImport(CoreNFC)
    private var session: NFCNDEFReaderSession?
    private var pendingCall: CAPPluginCall?
    #endif

    @objc func scanNfc(_ call: CAPPluginCall) {
        #if canImport(CoreNFC)
        guard NFCNDEFReaderSession.readingAvailable else {
            call.reject("NFC reading isn't available on this device", "nfc_unavailable"); return
        }
        if pendingCall != nil { call.reject("A scan is already in progress", "nfc_busy"); return }
        call.keepAlive = true
        pendingCall = call
        let s = NFCNDEFReaderSession(delegate: self, queue: nil, invalidateAfterFirstRead: true)
        s.alertMessage = call.getString("message") ?? "Hold your iPhone near the TapTime tag"
        session = s
        s.begin()
        #else
        call.reject("NFC reading isn't available on this device", "nfc_unavailable")
        #endif
    }

    #if canImport(CoreNFC)
    private func finish(_ block: (CAPPluginCall) -> Void) {
        guard let call = pendingCall else { return }
        pendingCall = nil
        block(call)
        bridge?.releaseCall(call)
    }
    #endif
}

#if canImport(CoreNFC)
extension TapTimeNativePlugin: NFCNDEFReaderSessionDelegate {
    public func readerSession(_ session: NFCNDEFReaderSession, didInvalidateWithError error: Error) {
        // Cancelled, timed out, or already answered by didDetectNDEFs.
        finish { $0.reject(error.localizedDescription, "nfc_cancelled") }
        self.session = nil
    }

    public func readerSession(_ session: NFCNDEFReaderSession, didDetectNDEFs messages: [NFCNDEFMessage]) {
        var url: URL?
        for message in messages {
            for record in message.records {
                if let u = record.wellKnownTypeURIPayload() { url = u; break }
            }
            if url != nil { break }
        }
        finish { call in
            if let u = url { call.resolve(["url": u.absoluteString]) }
            else { call.reject("No link found on this tag", "nfc_no_url") }
        }
    }
}
#endif
