/*
 * Copyright 2024-2026 the original author or authors.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package io.agentscope.examples.chat;

import io.agentscope.core.agent.RuntimeContext;
import io.agentscope.core.message.Base64Source;
import io.agentscope.core.message.ContentBlock;
import io.agentscope.core.message.ImageBlock;
import io.agentscope.core.message.Msg;
import io.agentscope.core.message.TextBlock;
import io.agentscope.core.message.UserMessage;
import io.agentscope.core.message.VideoBlock;
import io.agentscope.core.model.Model;
import io.agentscope.core.model.ToolSchema;
import io.agentscope.core.session.SessionEvent;
import io.agentscope.core.session.SessionLog;
import io.agentscope.core.tool.Toolkit;
import io.agentscope.core.util.JsonUtils;
import io.agentscope.harness.agent.HarnessAgent;
import io.agentscope.harness.agent.filesystem.local.LocalFilesystem;
import io.agentscope.harness.agent.session.AgentSession;
import io.agentscope.harness.agent.session.WorkspaceSessionLogStore;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/** One local process owns execution; HTTP/SSE subscribers only observe it. */
public final class ChatSessions implements AutoCloseable {
    private static final String USER = "local-user";
    private static final String AGENT = "session-chat";
    private static final int MAX_ATTACHMENTS = 4;
    private static final int MAX_MEDIA_CHARS = 8 * 1024 * 1024;
    private final HarnessAgent agent;
    private final WorkspaceSessionLogStore store;
    private final String modelName;

    public ChatSessions(Path workspace, Model model) {
        modelName = model.getModelName();
        store = new WorkspaceSessionLogStore(new LocalFilesystem(workspace.toAbsolutePath()));
        var toolkit = new Toolkit();
        if (model instanceof DemoChatModel demo)
            toolkit.registerTool(new DemoTools(demo.toolDelay()));
        toolkit.registerSchema(
                ToolSchema.builder()
                        .name("ask_user")
                        .description(
                                "Ask the user for a missing preference and wait for their answer.")
                        .parameters(
                                Map.of(
                                        "type",
                                        "object",
                                        "properties",
                                        Map.of("question", Map.of("type", "string")),
                                        "required",
                                        List.of("question")))
                        .build());
        agent =
                HarnessAgent.builder()
                        .name("Session Chat")
                        .agentId(AGENT)
                        .model(model)
                        .sysPrompt(
                                "You are a concise chat assistant. Use ask_user when a needed"
                                        + " preference is missing.")
                        .workspace(workspace.toAbsolutePath())
                        .sessionLogStore(store)
                        .toolkit(toolkit)
                        .disableShellTool()
                        .disableFilesystemTools()
                        .disableWebTools()
                        .disableSubagents()
                        .disableDynamicSubagents()
                        .disableDynamicSkills()
                        .disableDefaultWorkspaceSkills()
                        .disableMemoryTools()
                        .disableMemoryHooks()
                        .disableToolsConfig()
                        .disableWorkspaceContext()
                        .disableAtPathExpansion()
                        .maxIters(8)
                        .build();
        list().forEach(id -> session(id).start());
    }

    public String modelName() {
        return modelName;
    }

    static String id(String value) {
        if (value == null || !value.matches("[A-Za-z0-9_-]{1,80}"))
            throw new IllegalArgumentException("Invalid ID");
        return value;
    }

    private RuntimeContext context(String session) {
        return RuntimeContext.builder().userId(USER).sessionId(id(session)).build();
    }

    SessionLog log(String session) {
        return session(session).log();
    }

    AgentSession session(String id) {
        return agent.session(context(id));
    }

    public List<String> list() {
        return store.list(RuntimeContext.builder().userId(USER).build()).stream()
                .filter(key -> key.agentId().equals(AGENT))
                .map(key -> key.sessionId())
                .sorted()
                .toList();
    }

    public ChatHistory.Snapshot snapshot(String id) {
        var session = session(id);
        return ChatHistory.snapshot(id, session.log(), session.executionError(), session.tasks());
    }

    public AgentSession.Task submit(String session, String requestId, String text) {
        return submit(session, requestId, text, List.of());
    }

    public AgentSession.Task submit(
            String session, String requestId, String text, List<Attachment> attachments) {
        return session(session).submit(id(requestId), List.of(message(text, attachments, null)));
    }

    public AgentSession.Task resume(String session, String turn) {
        return session(session).resume(id(turn));
    }

    public AgentSession.Task answer(String session, String request, String output) {
        validateText(output);
        return session(session).respond(id(request), output);
    }

    public AgentSession.InputReceipt steer(String session, String text) {
        return steer(session, text, List.of());
    }

    public AgentSession.InputReceipt steer(
            String session, String text, List<Attachment> attachments) {
        return session(session).steer(List.of(message(text, attachments, "steer")));
    }

    public AgentSession.InputReceipt inject(String session, String text) {
        return inject(session, text, List.of());
    }

    public AgentSession.InputReceipt inject(
            String session, String text, List<Attachment> attachments) {
        return session(session).inject(List.of(message(text, attachments, "inject")));
    }

    /**
     * Inline image or video sent as a Base64 content block. Keeping the bytes in the message makes
     * the media durable in the event log and lets any model adapter read it.
     */
    record Attachment(String mediaType, String data) {}

    // The offline model uses this hint to distinguish demo commands from supplemental inputs.
    private static Msg message(String text, List<Attachment> attachments, String kind) {
        String value = text == null ? "" : text.trim();
        if (value.length() > 8000)
            throw new IllegalArgumentException("Message must contain 1–8000 characters");
        if (attachments.size() > MAX_ATTACHMENTS)
            throw new IllegalArgumentException(
                    "At most " + MAX_ATTACHMENTS + " images or videos are allowed");
        var blocks = new ArrayList<ContentBlock>();
        if (!value.isEmpty()) blocks.add(TextBlock.builder().text(value).build());
        attachments.forEach(attachment -> blocks.add(block(attachment)));
        if (blocks.isEmpty())
            throw new IllegalArgumentException("Message must contain text, an image or a video");
        var message = UserMessage.builder().content(List.copyOf(blocks));
        if (kind != null) message.metadata(Map.of("chat_input_kind", kind));
        return message.build();
    }

    private static ContentBlock block(Attachment attachment) {
        String mediaType =
                attachment.mediaType() == null
                        ? ""
                        : attachment.mediaType().trim().toLowerCase(Locale.ROOT);
        String data = attachment.data();
        if (data == null || data.isBlank())
            throw new IllegalArgumentException("Attachment data is required");
        if (data.length() > MAX_MEDIA_CHARS)
            throw new IllegalArgumentException("Attachment is too large");
        var source = new Base64Source(mediaType, data);
        if (mediaType.startsWith("image/")) return ImageBlock.builder().source(source).build();
        if (mediaType.startsWith("video/")) return VideoBlock.builder().source(source).build();
        throw new IllegalArgumentException("Only image/* and video/* attachments are supported");
    }

    public boolean interrupt(String session, String runId) {
        return session(session).interrupt(runId);
    }

    private static void validateText(String text) {
        if (text == null || text.isBlank() || text.length() > 8000)
            throw new IllegalArgumentException("Message must contain 1–8000 characters");
    }

    List<SessionEvent> events(String session, long after, int limit) {
        if (limit < 1 || limit > 256) throw new IllegalArgumentException("Limit must be 1–256");
        SessionLog log = log(session);
        if (after > log.head().seq())
            throw new IllegalArgumentException("Cursor is ahead of history; reload the snapshot");
        return log.readAfter(after, limit);
    }

    /** Full native record set, one JSON object per line, ready for offline inspection or replay. */
    String export(String session) {
        SessionLog log = log(session);
        var lines = new StringBuilder();
        log.scan(0, log.head().seq())
                .forEach(
                        event -> lines.append(JsonUtils.getJsonCodec().toJson(event)).append('\n'));
        return lines.toString();
    }

    @Override
    public void close() {
        agent.close();
    }
}
