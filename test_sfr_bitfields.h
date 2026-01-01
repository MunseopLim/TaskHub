#include <cstdint>

// Test file for SFR bit field hover feature

class RegTestInt
{
public:
  template <typename Type>
  union IntRegSts
  {
    Type dword;
    struct
    {
      Type int0_set  : 1; // [0]       [RW1C][0x0] Test interrupt 1
      Type int1_set  : 1; // [1]       [RW1C][0x0] Test interrupt 2
      Type int2_set  : 1; // [2]       [RW1C][0x0] Test interrupt 3
      Type int3_set  : 1; // [3]       [RW1C][0x0] Test interrupt 4
      Type int4_set  : 1; // [4]       [RW1C][0x0] Test interrupt 5
      Type int5_set  : 1; // [5]       [RW1C][0x0] Test interrupt 6
      Type int6_set  : 1; // [6]       [RW1C][0x0] Test interrupt 7
      Type int7_set  : 1; // [7]       [RW1C][0x0] Test interrupt 8
      Type int8_set  : 1; // [8]       [RW1C][0x0] Test interrupt 9
      Type int9_set  : 1; // [9]       [RW1C][0x0] Test interrupt 10
      Type int_field_0 : 3; // [12:10][RW1C][0x7] Test field 0
      Type reserved : 19; // [31:13][RO][0x0] Reserved field
    } rst;
  };
  IntRegSts<volatile uint32_t> uIntRegSts;
};

// Usage example
void test() {
    RegTestInt::IntRegSts<uint32_t> uIntTestSts;
    uIntTestSts.rst.int0_set = 1;
    uIntTestSts.rst.int_field_0 = 5;
}
