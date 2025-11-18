import { getConvexSiteUrl } from "@/lib/utils";
import { StreamId } from "@convex-dev/persistent-text-streaming";
import { useStream } from "@convex-dev/persistent-text-streaming/react";
import { api } from "../../convex/_generated/api";
import { Doc } from "../../convex/_generated/dataModel";
import { useMemo, useEffect } from "react";
import Markdown from "react-markdown";

export function ServerMessage({
  message,
  isDriven,
  stopStreaming,
  scrollToBottom,
}: {
  message: Doc<"userMessages">;
  isDriven: boolean;
  stopStreaming: () => void;
  scrollToBottom: () => void;
}) {
  const { text, reasoning, status } = useStream(
    api.streaming.getStreamBody,
    new URL(`${getConvexSiteUrl()}/chat-stream`),
    isDriven,
    message.responseStreamId as StreamId,
  );

  const isCurrentlyStreaming = useMemo(() => {
    if (!isDriven) return false;
    return status === "pending" || status === "streaming";
  }, [isDriven, status]);

  useEffect(() => {
    if (!isDriven) return;
    if (isCurrentlyStreaming) return;
    stopStreaming();
  }, [isDriven, isCurrentlyStreaming, stopStreaming]);

  useEffect(() => {
    if (!text) return;
    scrollToBottom();
  }, [text, scrollToBottom]);

  return (
    <div className="md-answer">
      {reasoning && reasoning.length > 0 && (
        <div className="mb-3 pb-3 border-b border-gray-200">
          <div className="text-xs text-gray-500 mb-2">Reasoning:</div>
          <div className="text-sm text-gray-600">
            <Markdown>{reasoning}</Markdown>
          </div>
        </div>
      )}
      <Markdown>{text}</Markdown>
      {status === "error" && (
        <div className="text-red-500 mt-2">Error loading response</div>
      )}
    </div>
  );
}
