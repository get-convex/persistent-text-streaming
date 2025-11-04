# Chat Example App

This is a simple chat app that uses the persistent text streaming component.
When a new prompt is submitted, the app will stream the response from the OpenAI
API back to the client and write the prompt and response to the database in an
efficient way. When the app is refreshed, it will use the database to value to
restore the chat. Other concurrent browser sessions will also see the chat
updates by subscribing to the Convex database records in the usual way.

## Running the app

### Prerequisites

- Node.js (v18+)
- npm (v10+)

### Provisioning the backend and starting the frontend

```bash
npm install
npm run dev # in one terminal
npm run dev:frontend # in another terminal
```

### Establishing your OPENAI_API_KEY

This chat app talks to OpenAI's API. You need to set the `OPENAI_API_KEY`
environment variable inside your Convex backend.

1.  Download an API key from [OpenAI](https://platform.openai.com/api-keys).
2.  Run `npx convex env set OPENAI_API_KEY=<your-key>`

Then you should be able to chat successfully with the app. Pop up the Convex
dashboard to debug any issues (the `npx convex dashboard` command will get you
to the right place).
