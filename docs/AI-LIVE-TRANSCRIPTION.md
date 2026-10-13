# HHCS-CRM: Gemini live transcription and AI Summary

The CRM uses `gemini-3.5-transcribe-live` for speech while a call is happening. A separate text model, `gemini-2.5-flash` by default, generates the summary, intent, sentiment, extracted fields, flags and QA afterward. A transcription model cannot produce the CRM's structured summary by itself.

## Create the permanent Gemini API key

1. Open [Google AI Studio API keys](https://aistudio.google.com/api-keys) and sign in with the Google account responsible for HHCS-CRM.
2. Select the Google Cloud project used for this app. If it is missing, open Dashboard > Projects > Import projects, select it, then Import. Return to API Keys.
3. Click **Create API key**, select that project and give the key a name such as **HHCS-CRM Gemini**. Google AI Studio creates authorization keys by default.
4. Open the project's billing information in AI Studio. For patient calls, use a billing-enabled project: Google's paid API tier does not use inputs and outputs to improve its products; the free tier does. Review the charges before enabling billing. The CRM does not enable billing or purchase anything for you.
5. Copy the new key. Open [HHCS-CRM](https://hhcs-caredesk.secondmedic.workers.dev), sign in as an admin or supervisor, then go to **Settings > Telephony & integrations > AI call summaries**.
6. Paste it into **Gemini API key**. Leave **Summary model** empty to use `gemini-2.5-flash`. Click **Save**.
7. Click **Test key**. This checks the summary model and creation of a live session token. Successful token creation still needs a live audio test to confirm the model is available to the project.
8. If you want summaries to run after calls, leave **Summarise finished calls automatically** checked. If an old quota failure paused summaries, fix the quota/key and use **Retry failed calls**.

Never paste the key into chat, source code, a model field, or browser JavaScript. The app saves it on the server and shows only its last four characters. New keys created through AI Studio are restricted to the Gemini API by default. See [Google's API key guide](https://ai.google.dev/gemini-api/docs/api-key).

## How the live token is created

You do not manually create a new token for each call. When you click **Start transcription**, the signed-in CRM requests a token from its backend. The backend verifies your role and call access, then calls Google's `auth_tokens` service with the permanent API key in an HTTP header.

The returned token is limited to one session, must start within one minute, expires after 30 minutes, and is constrained to the Gemini 3.5 Transcribe Live setup. The browser receives this short-lived token, never the permanent key. When Gemini renews a connection, the CRM uses its session resumption handle to reconnect. See [Google's ephemeral token guide](https://ai.google.dev/gemini-api/docs/live-api/ephemeral-tokens).

## Use it during a call

1. Make or answer a normal MyOperator call through the CRM. The call still connects on the agent's registered phone.
2. Put that phone on speaker, close to the computer's microphone. Make sure both people know and agree that their speech will be transcribed by Google.
3. Click **Live transcript** at the bottom right of the CRM. Confirm the consent checkbox, then **Start transcription**.
4. Allow microphone access when your browser asks. Use a current browser with microphone and AudioWorklet support, and open the CRM over HTTPS.
5. Confirm that the status changes to **listening** and words appear. The grey preview is provisional; only final words are committed. Language detection is automatic, including English, Hindi and Marathi.
6. Keep the CRM tab open. You can navigate between CRM pages while capture continues. Final words save about every 30 seconds and when you stop.
7. Click **Stop and save** when finished. If the CRM receives the MyOperator call-ended event, it stops and saves automatically. If that event is delayed, stop manually after hanging up.
8. Once the call is marked completed, automatic AI Summary uses the saved transcript. If automatic summaries are off, open **Calls & recordings**, select the call and click **Run AI summary**. Review the transcript and summary against the recording before acting.

## Audio source and limits

This implementation captures the browser's microphone. It does not receive a direct MyOperator audio feed. A headset microphone usually captures only the agent; use speakerphone so it can hear the caller too. Noise, a muted phone speaker, starting late or stopping early can produce an incomplete transcript and summary. Live transcription does not identify speakers automatically in this implementation, and the final transcript is preserved in the original spoken language.

If a live session is interrupted, keep the panel open and use **Retry saving**, then restart if the call is still active. If a preview did not finalise, it is excluded from the saved transcript and the panel says so. Transcript snapshots cannot overwrite different or newer saved words. Each call is limited to 100,000 transcript characters. Only operational roles can start/save capture; agents can capture only their assigned calls. Existing call visibility, patient isolation and phone masking still apply.

Calls without a finished, non-empty live transcript keep the existing MyOperator recording analysis path. That path uploads the recording through Google's Files API and deletes the uploaded file afterward. Live audio is streamed to Google directly, and the transcript is stored in the CRM; deleting recording uploads does not imply that Google's live API has no service-side retention.

## Charges

As checked on 13 October 2026, Google lists an estimated paid rate of **US$0.009 per audio minute** for Gemini 3.5 Transcribe Live, plus the separate summary model's token charges. Actual charges depend on audio/text token use. Check [Google's current pricing](https://ai.google.dev/gemini-api/docs/pricing#gemini-3.5-transcribe-live) and your project's quotas before use. Existing Cloudflare and Supabase hosting remain unchanged.

## Troubleshooting

- **No Gemini key:** add and save the key in CRM Settings.
- **Key refused or quota exceeded:** check that it belongs to the intended project, that Gemini API access is available, and that the project has remaining quota. Fix the problem, then Test key again.
- **No live words:** check the selected microphone and speakerphone volume. A successful key test proves token creation, not microphone capture or live model access.
- **Disconnected:** wait for reconnection; if it reports interruption, save the captured words before restarting.
- **Summary still pending:** the call must be marked completed and the live transcript saved. The fallback queue runs once a minute. Use the call's summary button if automatic processing is off.
- **Only one person's words:** the microphone hears only one person. Change the audio arrangement before relying on the transcript.

Protocol reference: [Gemini 3.5 Live Transcription](https://ai.google.dev/gemini-api/docs/live-api/live-transcribe), [REST AuthToken](https://ai.google.dev/api/generate-content#v1beta.AuthToken).
