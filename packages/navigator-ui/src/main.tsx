import { createRoot } from "react-dom/client";
import { StrictMode } from "react";
import { App } from "./App.js";
import "./style.css";

const container = document.getElementById("root");
if (container === null) throw new Error("navigator: no #root element");
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
