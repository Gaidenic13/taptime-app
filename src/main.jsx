import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App.jsx";
import "./styles.css";
import { initNative, hideSplash } from "./native.js";

// The native app restores its identity from the Keychain before the first
// request goes out; on the web this resolves immediately.
initNative().finally(() => {
  createRoot(document.getElementById("root")).render(
    <BrowserRouter>
      <App />
    </BrowserRouter>
  );
  hideSplash();
});
