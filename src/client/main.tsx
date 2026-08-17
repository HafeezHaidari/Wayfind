import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.js";

import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/screens.css";
import "./styles/rail.css";
import "./styles/map.css";
import "./styles/print.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
