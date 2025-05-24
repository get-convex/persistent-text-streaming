import { Unauthenticated } from "convex/react";
import "./App.css";
import ChatWindow from "./components/ChatWindow";
import { useAuthActions } from "@convex-dev/auth/react";

export function SignIn() {
  const { signIn } = useAuthActions();
  return (
    <form
      className="flex justify-center items-center h-screen"
      onSubmit={(event) => {
        event.preventDefault();
        void signIn("anonymous");
      }}
    >
      <button type="submit">Sign in</button>
    </form>
  );
}

function App() {
  return (
    <>
      <main className="flex min-h-screen flex-col">
        <Unauthenticated>
          <SignIn />
        </Unauthenticated>
        <ChatWindow />
      </main>
    </>
  );
}

export default App;
