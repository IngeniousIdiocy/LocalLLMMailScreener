# LocalLLMMailScreener
A single Node server that polls Gmail for new emails and for each new email, sends the FULL email text to a local MLX LLM server, then the LLM returns strict JSON: { notify: boolean, message_packet: { title, body, urgency } , ... }, if notify=true, send the message_packet via Twilio SMS to subscribers and host a simple dashboard page
