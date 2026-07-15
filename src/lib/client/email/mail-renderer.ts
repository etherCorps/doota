import { Renderer, toPlainText } from "@better-svelte-email/server";
import type { Component, ComponentProps } from "svelte";

const { render } = new Renderer();

export async function renderEmail<Template extends Component<any>>(
  template: Template,
  props: ComponentProps<Template>,
): Promise<{ html: string; text: string }> {
  const html = await render(template, props);
  if (!html) throw new Error("Failed to render email template");
  const text = toPlainText(html);
  return { html, text };
}
