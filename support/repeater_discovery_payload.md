# Control Payload: Node Discovery (Repeater)

Source: `examples/simple_repeater/MyMesh.cpp`

## Discovery Request (`CTL_TYPE_NODE_DISCOVER_REQ = 0x80`)
```
Offset  Size  Field                 Notes
0       1     type_flags            Upper nibble = 0x8 (REQ). Bit0 = prefix_only flag.
1       1     filter                Bitmask; bit (1 << ADV_TYPE_REPEATER) must be set to trigger repeater response.
2       4     tag                   uint32, echoed in response.
6       4     since (optional)      uint32; if omitted, treated as 0.
```

## Discovery Response (`CTL_TYPE_NODE_DISCOVER_RESP = 0x90`)
```
Offset  Size  Field                 Notes
0       1     type_node             0x90 | ADV_TYPE_REPEATER (node type in low nibble).
1       1     snr_x4                Inbound SNR * 4 from receiver.
2       4     tag                   Echo of request tag.
6       8     pubkey_prefix         Only if prefix_only flag set in request.
6       32    pubkey_full           Full PUB_KEY_SIZE when prefix_only is not set.
```

## Routing Constraints
- Must be `PAYLOAD_TYPE_CONTROL` (`0x0B`) and **direct** route with `path_len == 0`.
- Only control payloads with `(payload[0] & 0x80) != 0` are accepted for `onControlDataRecv`.
