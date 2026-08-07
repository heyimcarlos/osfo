// @vitest-environment happy-dom

import { DevelopmentBootstrapCapability, DevelopmentDemoSession } from "@osfo/api";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  ConfigurationRequired,
  type ReferenceClientAuthorityInput,
} from "./configuration-required";
import { referenceClientAuthorityStorageKey } from "./reference-client-config";

const threadId = "6ef239bd-3f04-4c77-8976-1171e75ea0ab";
const authenticationToken = "generated-authentication-token";

const demoSession = new DevelopmentDemoSession({
  authenticationToken,
  expiresAt: "2026-08-07T23:00:00.000Z",
  productionQualification: "MISSING",
  protocolVersion: 1,
  scope: "development",
  threadId,
});

const capability = new DevelopmentBootstrapCapability({
  enabled: true,
  productionQualification: "MISSING",
  scope: "development",
});

const setInputValue = (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};

const mount = async (
  props: ComponentProps<typeof ConfigurationRequired>,
): Promise<{ readonly container: HTMLDivElement; readonly root: Root }> => {
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(() =>
    root.render(
      <ConfigurationRequired
        getBootstrapCapability={() => Effect.succeed(capability)}
        {...props}
      />,
    ),
  );
  return { container, root };
};

const unmount = (root: Root) => act(() => root.unmount());

describe("development demo session bootstrap", () => {
  it("hides the generator when ingress does not advertise the development capability", async () => {
    const { container, root } = await mount({
      getBootstrapCapability: () => Effect.fail("route absent"),
    });

    try {
      expect(container.textContent).not.toContain("Generate new Thread");
      expect(container.querySelector<HTMLInputElement>('[name="accessCode"]')).toBeNull();
      expect(container.querySelector<HTMLInputElement>('[name="threadId"]')).not.toBeNull();
      expect(
        container.querySelector<HTMLInputElement>('[name="authenticationToken"]'),
      ).not.toBeNull();
    } finally {
      await unmount(root);
    }
  });

  it("fills generated authority, clears the access code, and waits for explicit Connect", async () => {
    globalThis.sessionStorage.clear();
    let connected: ReferenceClientAuthorityInput | undefined;
    const { container, root } = await mount({
      createDemoSession: ({ accessCode, baseUrl }) => {
        expect(accessCode).toBe("demo-access-code");
        expect(baseUrl).toBe(globalThis.location.origin);
        return Effect.succeed(demoSession);
      },
      onConnect: (authority) => {
        connected = authority;
      },
    });

    try {
      const accessCodeInput = container.querySelector<HTMLInputElement>('[name="accessCode"]');
      const generateForm = accessCodeInput?.closest("form");
      expect(accessCodeInput).not.toBeNull();
      expect(generateForm).not.toBeNull();

      await act(async () => {
        setInputValue(accessCodeInput!, "demo-access-code");
        generateForm!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      });

      expect(accessCodeInput!.value).toBe("");
      expect(container.querySelector<HTMLInputElement>('[name="threadId"]')?.value).toBe(threadId);
      expect(container.querySelector<HTMLInputElement>('[name="authenticationToken"]')?.value).toBe(
        authenticationToken,
      );
      expect(connected).toBeUndefined();
      expect(globalThis.sessionStorage.getItem(referenceClientAuthorityStorageKey)).toBeNull();
    } finally {
      await unmount(root);
    }
  });

  it("renders a generic failure without exposing invalid access details", async () => {
    const rejectedSecret = "invalid-secret-that-must-not-leak";
    const { container, root } = await mount({
      createDemoSession: () => Effect.fail(new Error(`Rejected ${rejectedSecret}`)),
    });

    try {
      const accessCodeInput = container.querySelector<HTMLInputElement>('[name="accessCode"]')!;
      await act(async () => {
        setInputValue(accessCodeInput, rejectedSecret);
        accessCodeInput
          .closest("form")!
          .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      });

      expect(container.querySelector('[role="alert"]')?.textContent).toBe(
        "A development session could not be generated. Check the access code or use manual entry.",
      );
      expect(container.textContent).not.toContain(rejectedSecret);
      expect(container.textContent).not.toContain("Rejected");
      expect(accessCodeInput.value).toBe("");
      expect(container.textContent).toContain("Manual entry");
    } finally {
      await unmount(root);
    }
  });

  it("represents a disabled bootstrap route as the same safe generic error", async () => {
    const { container, root } = await mount({
      createDemoSession: () => Effect.fail("development bootstrap unavailable"),
    });

    try {
      const accessCodeInput = container.querySelector<HTMLInputElement>('[name="accessCode"]')!;
      await act(async () => {
        setInputValue(accessCodeInput, "access-code");
        accessCodeInput
          .closest("form")!
          .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      });

      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "could not be generated",
      );
      expect(container.textContent).not.toContain("bootstrap unavailable");
      expect(container.querySelector<HTMLInputElement>('[name="threadId"]')).not.toBeNull();
      expect(
        container.querySelector<HTMLInputElement>('[name="authenticationToken"]'),
      ).not.toBeNull();
    } finally {
      await unmount(root);
    }
  });
});
