---
title: Assistant owner options
summary: Running the assistant on a local model, letting members bring their own key, counting their keys toward the limit, and the monthly token allowance.
audience: user
section: Guides
specs: []
screens: []
order: 82
---
# Assistant owner options

<picture><source srcset="images/assistant-settings-dark.webp" media="(prefers-color-scheme: dark)"><img src="images/assistant-settings-light.webp" alt="Settings, Integrations, the Assistant card as the owner sees it, with the monthly limit and whether members may bring their own key."></picture>

Once the [assistant is on](assistant-setup.md), the owner can point it at a model on the local network and decide how members' own keys and the monthly allowance work.

## A local model

Run Ollama or LM Studio on a machine in your network, choose **Compatible endpoint**, enter its base URL (Ollama: `http://<host>:11434/v1`; LM Studio: `http://<host>:1234/v1`) and a model that supports tools, and tick **Allow private endpoints**. Small models answer questions well but struggle with the multi-step [skills](assistant-skills.md#skills): in testing, a 3-billion-parameter model handled **Break this down** but not the others, so choose a model of 7B or more for skills. Without that switch, addresses on private networks are refused, the same rule as for [webhooks](webhooks.md).

## On-device assistant for encrypted accounts

**Let encrypted accounts use the assistant from their own device** (off by default) lets people with end-to-end encryption run the assistant in their browser with their own key; your keys are never used, and the server sees no content. While it is on, pages of the server may connect to the providers you allow. See [Assistant on encrypted accounts](assistant-encrypted.md#for-the-server-owner).

## Other settings

- **Let members bring their own key**: each person may then choose Anthropic, OpenAI or Google Gemini with their own model and key in **Settings → Integrations → Assistant**; their turns use it instead of yours. Members are never offered the compatible endpoint, so they cannot make your server connect to an address of their choosing. Turning this off makes everyone use your provider again (each person accepts its disclosure again); their choices are kept for when you turn it back on. Settings shows how many people use their own provider and key. What members see is in [Assistant settings](assistant-settings.md#use-your-own-provider-and-key).
- **Count members' own keys toward the monthly limit**: off by default, so a member who pays with their own key is not held to your allowance. Turn it on to apply one limit to every answer. One answer at a time per person and 8 at a time on the server apply either way.
- **Monthly tokens per person**: 500,000 by default; `0` means unlimited.
- Changing the provider asks everyone to accept the disclosure again.
- Keys are stored in `<data>/secrets/assistant.json` (mode 0600), never shown again, never in backups, exports or logs. The audit log records `settings.changed` with `assistant.<provider>.key` going from `unset` to `set`, never the key.

Network details for operators are in [Running with Docker](self-hosting/docker.md#in-app-assistant); the routes are in the [API reference](api.md#in-app-assistant).
