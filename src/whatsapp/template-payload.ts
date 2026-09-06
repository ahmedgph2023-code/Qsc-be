import { HttpError } from "./errors.js";

export type TemplateButtonInput = {
  type: string;
  text: string;
  url?: string;
  phone_number?: string;
};

export type TemplateComponentInput = {
  bodyText: string;
  headerFormat?: string;
  headerText?: string;
  headerHandle?: string;
  existingHeaderComponent?: Record<string, unknown> | null;
  footerText?: string;
  buttons?: TemplateButtonInput[];
  exampleBodyParams?: string[];
  exampleHeaderParams?: string[];
};

function normalizeTemplateText(text: string) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\{\{\s*(\d+)\s*\}\}/g, "{{$1}}")
    .trim();
}

function positionalVarIndexes(text: string): number[] {
  return [
    ...new Set([...String(text || "").matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1]))),
  ].sort((a, b) => a - b);
}

export function assertTemplatePlaceholders(text: string, field: string) {
  const matches = [...String(text || "").matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)];
  for (const m of matches) {
    const token = String(m[1]).trim();
    if (!/^\d+$/.test(token)) {
      throw new HttpError(
        400,
        `Invalid parameter in ${field}: use {{1}}, {{2}} — not {{${token}}}. Meta rejected named variables.`,
      );
    }
  }
  const indexes = positionalVarIndexes(text);
  for (let i = 0; i < indexes.length; i += 1) {
    if (indexes[i] !== i + 1) {
      throw new HttpError(400, `Placeholders in ${field} must be sequential starting at {{1}}`);
    }
  }
}

export function buildMessageTemplateComponents(input: TemplateComponentInput) {
  const components: Record<string, unknown>[] = [];
  const headerFormat = String(input.headerFormat || "NONE").toUpperCase();
  const bodyText = normalizeTemplateText(input.bodyText);
  const headerText = normalizeTemplateText(input.headerText || "");
  const footerText = normalizeTemplateText(input.footerText || "");

  if (!bodyText) throw new HttpError(400, "Template body text is required");
  assertTemplatePlaceholders(bodyText, "body");
  if (headerFormat === "TEXT" && headerText) {
    assertTemplatePlaceholders(headerText, "header");
    if (positionalVarIndexes(headerText).length > 1) {
      throw new HttpError(400, "TEXT header allows only one variable: {{1}}");
    }
  }
  if (footerText && /\{\{/.test(footerText)) {
    throw new HttpError(400, "Footer cannot contain variables like {{1}}");
  }

  if (headerFormat === "TEXT" && headerText) {
    const header: Record<string, unknown> = { type: "HEADER", format: "TEXT", text: headerText };
    if (positionalVarIndexes(headerText).length) {
      const headerExamples = input.exampleHeaderParams?.filter(Boolean) || [];
      header.example = { header_text: [headerExamples[0] || "Sample"] };
    }
    components.push(header);
  } else if (["IMAGE", "VIDEO", "DOCUMENT"].includes(headerFormat)) {
    if (input.headerHandle?.trim()) {
      components.push({
        type: "HEADER",
        format: headerFormat,
        example: { header_handle: [input.headerHandle.trim()] },
      });
    } else if (input.existingHeaderComponent) {
      components.push(input.existingHeaderComponent);
    } else {
      throw new HttpError(400, `Sample ${headerFormat.toLowerCase()} is required for ${headerFormat} header`);
    }
  }

  const body: Record<string, unknown> = { type: "BODY", text: bodyText };
  const bodyVars = positionalVarIndexes(bodyText);
  if (bodyVars.length) {
    const bodyExamples = input.exampleBodyParams?.filter(Boolean) || [];
    const examples = bodyVars.map((n, i) => bodyExamples[i] || `Sample ${n}`);
    body.example = { body_text: [examples] };
  }
  components.push(body);

  if (footerText) components.push({ type: "FOOTER", text: footerText });

  const buttons = (input.buttons || [])
    .map((b) => ({
      type: String(b.type || "").toUpperCase(),
      text: String(b.text || "").trim().slice(0, 25),
      url: b.url?.trim(),
      phone_number: b.phone_number?.trim(),
    }))
    .filter((b) => b.text && ["QUICK_REPLY", "URL", "PHONE_NUMBER"].includes(b.type));

  if (buttons.length) {
    if (buttons.length > 10) throw new HttpError(400, "Maximum 10 buttons allowed");
    if (buttons.filter((b) => b.type === "URL").length > 2) {
      throw new HttpError(400, "Maximum 2 URL buttons");
    }
    if (buttons.filter((b) => b.type === "PHONE_NUMBER").length > 1) {
      throw new HttpError(400, "Maximum 1 phone button");
    }
    components.push({
      type: "BUTTONS",
      buttons: buttons.map((b) => {
        if (b.type === "URL") {
          if (!b.url) throw new HttpError(400, "URL button requires a url");
          if (!/^https:\/\//i.test(b.url)) {
            throw new HttpError(400, "URL buttons must start with https://");
          }
          assertTemplatePlaceholders(b.url, "button url");
          const btn: Record<string, unknown> = { type: "URL", text: b.text, url: b.url };
          if (/\{\{/.test(b.url)) {
            btn.example = [b.url.replace(/\{\{\s*\d+\s*\}\}/g, "sample")];
          }
          return btn;
        }
        if (b.type === "PHONE_NUMBER") {
          if (!b.phone_number) throw new HttpError(400, "Phone button requires phone_number");
          const phone = b.phone_number.replace(/[^\d+]/g, "");
          if (phone.replace(/\D/g, "").length < 8) {
            throw new HttpError(400, "Phone button number is invalid");
          }
          return { type: "PHONE_NUMBER", text: b.text, phone_number: phone };
        }
        return { type: "QUICK_REPLY", text: b.text };
      }),
    });
  }

  return components;
}
