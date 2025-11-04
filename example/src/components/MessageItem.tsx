import { Doc } from "../../convex/_generated/dataModel";

type Props = {
  message: Doc<"userMessages">;
  children: React.ReactNode;
  isUser: boolean;
};

export default function MessageItem({ message, children, isUser }: Props) {
  return (
    <>
      {isUser && (
        <div className="flex items-center gap-4 my-4">
          <div className="flex-1 h-px bg-gray-200" />
          <div className="text-sm text-gray-500">
            {new Date(message._creationTime).toLocaleDateString()}{" "}
            {new Date(message._creationTime).toLocaleTimeString()}
          </div>
          <div className="flex-1 h-px bg-gray-200" />
        </div>
      )}

      <div className={`flex gap-4 ${isUser ? "justify-end" : "justify-start"}`}>
        <div
          className={`flex gap-4 max-w-[95%] md:max-w-[85%] ${isUser && "flex-row-reverse"}`}
        >
          <div
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${isUser ? "bg-blue-600 text-white" : "bg-gray-300 text-gray-700"} font-medium text-sm`}
          >
            {isUser ? "U" : "AI"}
          </div>

          <div
            className={`rounded-lg px-5 py-4 text-base ${
              isUser
                ? "bg-blue-600 text-white"
                : "bg-gray-100 border border-gray-200 text-gray-900"
            }`}
          >
            {children}
          </div>
        </div>
      </div>
    </>
  );
}
