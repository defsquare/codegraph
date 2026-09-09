import { mountCityView } from "./cityView.js";

/**
 * The standalone page: the city view mounted full-window. Load ceremony:
 * `?src=URL` is explicit (loud on failure); `/city.json` is the dev-server /
 * `codegraph history|replay --serve` convenience and stays quiet when nothing
 * serves it — then drag & drop or the file picker take over. `?landscape=1`
 * starts with buildings hidden.
 */
const host = document.getElementById("app");
if (host === null) throw new Error("index.html is missing #app");
const params = new URLSearchParams(window.location.search);
const view = mountCityView(host, { landscape: params.get("landscape") === "1" });
const src = params.get("src");
void view.loadUrl(src ?? "city.json", src === null);
