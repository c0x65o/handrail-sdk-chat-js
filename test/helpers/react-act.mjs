// React 18.2 exposes act through its renderer; React 19 exports it directly.
// Both paths exercise the real React scheduler, without a timing shim.
import * as React from "react";
export const act = React.act ?? (await import("react-dom/test-utils")).act;
