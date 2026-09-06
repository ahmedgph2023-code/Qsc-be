import { describe, expect, it } from "vitest";
import { buildWassengerMessageBody, normalizeWassengerPhone } from "./wassenger-client.js";

describe("wassenger-client", () => {
  it("normalizes phone to E.164-style +digits", () => {
    expect(normalizeWassengerPhone("97477320989")).toBe("+97477320989");
    expect(normalizeWassengerPhone("+97477320989")).toBe("+97477320989");
  });

  it("builds body matching QSC Wassenger curl (phone + message + media.url)", () => {
    const body = buildWassengerMessageBody({
      phone: "97477320989",
      message: "test from service2",
      mediaUrl: "http://res.cloudinary.com/dzpu9803l/image/upload/v1788330081/Qscreport-20260902-092115.pdf",
    });
    expect(body).toEqual({
      phone: "+97477320989",
      message: "test from service2",
      media: {
        url: "http://res.cloudinary.com/dzpu9803l/image/upload/v1788330081/Qscreport-20260902-092115.pdf",
      },
    });
  });

  it("builds body with media.file when file id provided", () => {
    const body = buildWassengerMessageBody({
      phone: "+97450055055",
      message: "QSC Portfolio Report",
      mediaFileId: "57443b8773c036f2bae0cd96",
    });
    expect(body).toEqual({
      phone: "+97450055055",
      message: "QSC Portfolio Report",
      media: { file: "57443b8773c036f2bae0cd96" },
    });
  });

  it("omits media when no URL or file", () => {
    const body = buildWassengerMessageBody({
      phone: "+97450055055",
      message: "QSC Portfolio Report",
    });
    expect(body.media).toBeUndefined();
    expect(body.phone).toBe("+97450055055");
  });
});
