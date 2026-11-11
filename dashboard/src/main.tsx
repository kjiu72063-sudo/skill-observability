import React from "react";
import { createRoot } from "react-dom/client";

import Shell from "./pages/Shell";
import "./styles/fonts.css";
import "./styles/tokens.css";
import "./styles/base.css";
import "./pages/Shell.css";

createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Shell />
  </React.StrictMode>
);
