#include <cstdint>

union UartCtrlReg {
    uint32_t dword;
    struct {
        uint32_t tx_en : 1;      // [0] [RW][0x0] Transmit enable
        uint32_t rx_en : 1;      // [1] [RW][0x0] Receive enable
        uint32_t parity_en : 1;  // [2] [RW][0x0] Parity enable
        uint32_t stop_bits : 2;  // [4:3] [RW][0x0] Stop bits
        uint32_t reserved1 : 3;  // [7:5] [RO][0x0] Reserved
        uint32_t baud_sel : 4;   // [11:8] [RW][0x0] Baud rate selector
        // [31:12] Reserved
    } bits;

    constexpr UartCtrlReg(uint32_t value) : dword(value) {}
};

struct PacketHeader {
    uint8_t version;
    uint32_t payloadLength;
    uint16_t flags;
};

void configureUart() {
    UartCtrlReg uart_ctrl = 0x30B;
}
