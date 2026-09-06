import { describe, expect, it } from "vitest";
import { assertTemplatePlaceholders, buildMessageTemplateComponents } from "./template-payload.js";
import { HttpError } from "./errors.js";

describe("WhatsApp template payload", () => {
  it("rejects named variables that Meta does not accept", () => {
    expect(() => assertTemplatePlaceholders("Hello {{name}}", "body")).toThrow(HttpError);
  });

  it("rejects non-sequential placeholders", () => {
    expect(() => assertTemplatePlaceholders("Hi {{1}} and {{3}}", "body")).toThrow(HttpError);
  });

  it("builds a valid UTILITY body with sequential examples", () => {
    const components = buildMessageTemplateComponents({
      bodyText: "Hello {{1}}, welcome to QSC.",
      exampleBodyParams: ["Ahmed"],
    });
    const body = components.find((c) => c.type === "BODY") as { example?: { body_text: string[][] } };
    expect(body.example?.body_text?.[0]).toEqual(["Ahmed"]);
  });

  it("requires https URL buttons and a media sample for IMAGE headers", () => {
    expect(() =>
      buildMessageTemplateComponents({
        bodyText: "Hello",
        buttons: [{ type: "URL", text: "Site", url: "http://example.com" }],
      }),
    ).toThrow(/https:\/\//);
    expect(() =>
      buildMessageTemplateComponents({
        bodyText: "Hello",
        headerFormat: "IMAGE",
      }),
    ).toThrow(/Sample image is required/);
  });
});
