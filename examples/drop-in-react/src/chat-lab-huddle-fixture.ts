import type { ChatLabFixtureConnectionStatus } from "./chat-lab-media";
import type { DeterministicChatLabMediaAdapter } from "./chat-lab-media";

export interface ChatLabHuddleFixtureBridge {
  setConnectionStatus(status: ChatLabFixtureConnectionStatus): boolean;
}

interface RestoredAttributes {
  readonly ariaLabel: string | null;
  readonly role: string | null;
}

const fixtureProperty = "__handrailChatLabHuddleFixture";

/**
 * Installs the opt-in browser bridge used by the canonical huddle lifecycle
 * case. The inactive production control remains the compact header action; the
 * fixture only gives its existing action group the logical region expected by
 * the lifecycle driver until ChatWorkspace mounts the active call bar.
 */
export const installChatLabHuddleFixture = ({
  mediaAdapter,
  root,
}: {
  readonly mediaAdapter: DeterministicChatLabMediaAdapter;
  readonly root: HTMLElement;
}): (() => void) => {
  const decoratedGroups = new Map<HTMLElement, RestoredAttributes>();
  let restoreDetailsAfterPrimaryAction = false;

  const restoreGroup = (group: HTMLElement) => {
    const attributes = decoratedGroups.get(group);
    if (attributes === undefined) return;
    if (attributes.role === null) group.removeAttribute("role");
    else group.setAttribute("role", attributes.role);
    if (attributes.ariaLabel === null) group.removeAttribute("aria-label");
    else group.setAttribute("aria-label", attributes.ariaLabel);
    decoratedGroups.delete(group);
  };

  const synchronizeAccessibleRegion = () => {
    if (restoreDetailsAfterPrimaryAction) {
      const details = root.querySelector<HTMLElement>(
        "[data-handrail-huddle-controls] .handrail-chat__huddle-details",
      );
      const trigger = root.querySelector<HTMLButtonElement>(
        "[data-handrail-huddle-controls] .handrail-chat__huddle-details-trigger",
      );
      if (details?.hidden === true && trigger !== null) {
        restoreDetailsAfterPrimaryAction = false;
        trigger.click();
      }
    }

    const activeControls = root.querySelector<HTMLElement>(
      "[data-handrail-huddle-controls]",
    );
    const headerControl = activeControls === null
      ? root.querySelector<HTMLElement>("[data-handrail-huddle-header-control]")
      : null;
    const headerGroup = headerControl?.closest<HTMLElement>(
      ".handrail-chat__header-actions",
    ) ?? null;

    for (const group of [...decoratedGroups.keys()]) {
      if (group !== headerGroup) restoreGroup(group);
    }
    if (headerGroup === null || decoratedGroups.has(headerGroup)) return;

    decoratedGroups.set(headerGroup, Object.freeze({
      ariaLabel: headerGroup.getAttribute("aria-label"),
      role: headerGroup.getAttribute("role"),
    }));
    headerGroup.setAttribute("aria-label", "Huddle controls");
    headerGroup.setAttribute("role", "region");
  };

  const preserveLifecycleDetails = (event: Event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const primaryAction = target.closest(
      "[data-handrail-huddle-controls] " +
      ".handrail-chat__huddle-actions--primary .handrail-chat__huddle-button",
    );
    if (primaryAction === null) return;
    const details = primaryAction.closest("[data-handrail-huddle-controls]")
      ?.querySelector<HTMLElement>(".handrail-chat__huddle-details");
    restoreDetailsAfterPrimaryAction = details?.hidden === false;
  };

  const observer = new MutationObserver(synchronizeAccessibleRegion);
  observer.observe(root, {
    attributeFilter: ["hidden"],
    attributes: true,
    childList: true,
    subtree: true,
  });
  document.addEventListener("pointerdown", preserveLifecycleDetails, true);
  synchronizeAccessibleRegion();

  const bridge: ChatLabHuddleFixtureBridge = Object.freeze({
    setConnectionStatus: (status: ChatLabFixtureConnectionStatus) =>
      mediaAdapter.setCurrentConnectionStatus(status),
  });
  const previousDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    fixtureProperty,
  );
  Object.defineProperty(globalThis, fixtureProperty, {
    configurable: true,
    value: bridge,
  });

  return () => {
    observer.disconnect();
    document.removeEventListener("pointerdown", preserveLifecycleDetails, true);
    for (const group of [...decoratedGroups.keys()]) restoreGroup(group);
    if (previousDescriptor === undefined) {
      Reflect.deleteProperty(globalThis, fixtureProperty);
    } else {
      Object.defineProperty(globalThis, fixtureProperty, previousDescriptor);
    }
  };
};
