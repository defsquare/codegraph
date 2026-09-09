import { useEffect, useRef } from "react";
import { mountCityView, type CityView, type NavigatorTarget } from "@codegraph/viz";

/**
 * The City tab: the 3D code city, full-width — no tree panel, the city IS the
 * navigation surface here. The viewer is `@codegraph/viz`'s mountable view
 * (Three.js stays confined to that package; this component never imports
 * `three`), mounted once into a host div and kept alive across tab switches:
 * uploading a real corpus to the GPU is too expensive to redo on every visit,
 * so a hidden tab only pauses the render loop.
 *
 * The city artifact is loaded the way the navigator artifact is: `?city=URL`
 * (loud), else the sibling `/city.json` the CLI's `serve` route hands out
 * (quiet when absent — then the view's own drop zone and picker take over).
 *
 * The hand-off: "Open in navigator" on a selected building or district calls
 * `onOpenInNavigator` with the entity id; the app resolves it against the
 * navigator's own nodes and reveals the match on the Navigate tab, with its
 * incoming and outgoing dependencies. Nothing is re-derived here.
 */
export interface CityTabProps {
  readonly active: boolean;
  /** Resolve the target in the navigator model and reveal it; false = unknown id. */
  readonly onOpenInNavigator: (target: NavigatorTarget) => boolean;
}

export function CityTab({ active, onOpenInNavigator }: CityTabProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<CityView | null>(null);
  // The latest callback without remounting the view (which would reload the city).
  const open = useRef(onOpenInNavigator);
  open.current = onOpenInNavigator;

  useEffect(() => {
    const element = host.current;
    if (element === null) return;
    const mounted = mountCityView(element, {
      onOpenInNavigator: (target) => open.current(target),
    });
    view.current = mounted;
    const src = new URLSearchParams(window.location.search).get("city");
    void mounted.loadUrl(src ?? "city.json", src === null);
    return () => {
      mounted.dispose();
      view.current = null;
    };
  }, []);

  useEffect(() => {
    view.current?.setActive(active);
  }, [active]);

  return <div className="city-tab" ref={host} />;
}
