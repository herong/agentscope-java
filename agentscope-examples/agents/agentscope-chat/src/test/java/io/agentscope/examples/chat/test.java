package io.agentscope.examples.chat;

public class test {

    String dd = "{\"turn\":2,\"reason\":{\"kind\":\"aborted\",\"reason\":{\"kind\":\"csc_agent\"}}}"
    public static void main(String[] args) {
        System.out.println(JsonUtils.getJsonCodec().toJson(Map.of("a", "b")));
    }


}
