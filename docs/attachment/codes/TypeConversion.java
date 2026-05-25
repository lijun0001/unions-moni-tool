package com.enneagon.v5.util;

@NotProguard
public class TypeConversion {
    public TypeConversion() {
    }


    public static String bytes2HexString(byte b) {
        StringBuffer result = new StringBuffer();
        String hex;
        if ((hex = Integer.toHexString(b & 255)).length() == 1) {
            hex = "0" + hex;
        }

        result.append(hex.toUpperCase());
        return result.toString();
    }

    public static String bytes2HexString(byte[] b) {
        StringBuffer result = new StringBuffer();

        for(int i = 0; i < b.length; ++i) {
            String hex;
            if ((hex = Integer.toHexString(b[i] & 255)).length() == 1) {
                hex = "0" + hex;
            }

            result.append(hex.toUpperCase());
        }

        return result.toString();
    }

    public static byte[] hexString2Bytes(String src) {
        int l;
        byte[] ret = new byte[l = src.length() / 2];

        for(int i = 0; i < l; ++i) {
            ret[i] = Integer.valueOf(src.substring(i * 2, i * 2 + 2), 16).byteValue();
        }

        return ret;
    }

    public static String string2HexString(String strPart) {
        StringBuffer hexString = new StringBuffer();

        for(int i = 0; i < strPart.length(); ++i) {
            String strHex = Integer.toHexString(strPart.charAt(i));
            hexString.append(strHex);
        }

        return hexString.toString().toUpperCase();
    }

    public static String hexString2String(String src) {
        String temp = "";

        for(int i = 0; i < src.length() / 2; ++i) {
            temp = temp + (char)Integer.valueOf(src.substring(i * 2, i * 2 + 2), 16).byteValue();
        }

        return temp;
    }

    public static String bytes2String(byte[] b) {
        return hexString2String(bytes2HexString(b));
    }

    public static Date bytes2Date(byte[] b) {
        return CommUtils.hexDate2ForDate(bytes2HexString(b));
    }

    public static long bytes2CurrTime(byte[] b) {
        Date date;
        return (date = bytes2Date(b)) != null ? date.getTime() : LocalDateTime.now().toInstant(ZoneOffset.of("+8")).toEpochMilli();
    }

    public static byte[] string2Bytes(String src) {
        return hexString2Bytes(string2HexString(src));
    }

    public static String intToHexString(int a, int len) {
        len <<= 1;
        String hexString = Integer.toHexString(a).toUpperCase();
        int b;
        if ((b = len - hexString.length()) > 0) {
            for(int i = 0; i < b; ++i) {
                hexString = "0" + hexString;
            }
        }

        return hexString;
    }

    public static byte getXor(byte[] datas) {
        byte temp = datas[0];

        for(int i = 1; i < datas.length; ++i) {
            temp ^= datas[i];
        }

        return temp;
    }

    public static String bcd2Str(byte[] bytes) {
        if (bytes.length == 0) {
            return "";
        } else {
            StringBuffer sb = new StringBuffer();

            for(int i = 0; i < bytes.length; ++i) {
                int h = ((bytes[i] & 255) >> 4) + 48;
                sb.append((char)h);
                int l = (bytes[i] & 15) + 48;
                sb.append((char)l);
            }

            return sb.toString();
        }
    }

    public static byte[] str2Bcd(String data) {
        if (data.length() == 0) {
            return new byte[0];
        } else {
            String str = data;
            if (data.length() % 2 != 0) {
                str = "0" + data;
            }

            ByteArrayOutputStream baos = new ByteArrayOutputStream();
            char[] cs = str.toCharArray();

            for(int i = 0; i < cs.length; i += 2) {
                int high = cs[i] - 48;
                int low = cs[i + 1] - 48;
                baos.write(high << 4 | low);
            }

            return baos.toByteArray();
        }
    }

    public static byte[] bcd(String code, int flag, int len) {
        int length;
        if ((length = code.length() % 2 == 0 ? code.length() / 2 : code.length() / 2 + 1) < 0) {
            throw new IllegalArgumentException("参数length不能小于0,length:" + length);
        } else if (length == 0) {
            return new byte[0];
        } else {
            byte[] bt = new byte[len];
            int point = 0;
            if (code.length() < 2 * length) {
                if (flag == 0) {
                    code = leftZeroShift(code, 2 * len);
                } else {
                    code = rightZeroShift(code, 2 * len);
                }
            }

            while(point < code.length()) {
                bt[(point + 1) / 2] = (byte)(Character.digit(code.charAt(point), 16) << 4 | Character.digit(code.charAt(point + 1), 16));
                point += 2;
            }

            return bt;
        }
    }

    public static String leftZeroShift(String s, int length) {
        String str;
        return s != null && s.length() <= length ? (str = getZero(length) + s).substring(str.length() - length) : s;
    }

    public static String rightZeroShift(String s, int length) {
        return s != null && s.length() <= length ? (s + getZero(length)).substring(0, length) : s;
    }

    static String getZero(int length) {
        String str = "";

        for(int i = 0; i < length; ++i) {
            str = str + "0";
        }

        return str;
    }

    public static String date2Hex(String date) {
        if (CommUtils.isEmpty(date)) {
            SimpleDateFormat sdf = new SimpleDateFormat("yyMMddHHmmss");
            Calendar cal = Calendar.getInstance();
            date = sdf.format(cal.getTime());
        }

        StringBuffer hexString = new StringBuffer();

        for(int i = 0; i < date.length() / 2; ++i) {
            String strHex = intToHexString(Integer.valueOf(date.substring(i * 2, i * 2 + 2)), 1);
            hexString.append(strHex);
        }

        return hexString.toString();
    }

    public static String hex2Date(String hexStr) {
        StringBuffer hexString = new StringBuffer();

        for(int i = 0; i < hexStr.length() / 2; ++i) {
            int ch;
            if ((ch = Integer.valueOf(hexStr.substring(i * 2, i * 2 + 2), 16)) <= 9 && ch >= 0) {
                hexString.append("0" + ch);
            } else {
                hexString.append(ch);
            }
        }

        return hexString.toString();
    }

    public static final void short2byteLe(int n, byte[] buf, int offset) {
        buf[offset] = (byte)n;
        buf[offset + 1] = (byte)(n >> 8);
    }

    public static final byte[] short2byteLe(int n) {
        byte[] buf;
        (buf = new byte[2])[0] = (byte)n;
        buf[1] = (byte)(n >> 8);
        return buf;
    }

    public static final int byte2shortLe(byte[] b, int offset) {
        return b[offset] & 255 | (b[offset + 1] & 255) << 8;
    }

    public static final int bytes2shortLe(byte[] b) {
        return b[0] & 255 | (b[1] & 255) << 8;
    }

    public static int getUnsignedByte(byte data) {
        return data & 255;
    }

    public static String hexStringPrint(String src) {
        String temp = "";

        for(int i = 0; i < src.length() / 2; ++i) {
            temp = temp + src.substring(i * 2, i * 2 + 2) + " ";
        }

        return temp;
    }

    public static final int bytes2intLe(byte[] b) {
        return b[0] & 255 | (b[1] & 255) << 8 | (b[2] & 255) << 16 | (b[3] & 255) << 24;
    }

    public static final long arr5ToU64(byte[] b) {
        return (long)(b[0] & 255 | (b[1] & 255) << 8 | (b[2] & 255) << 16 | (b[3] & 255) << 24 | (b[3] & 255) << 32);
    }

    public static byte[] int2bytesLe(int iSource) {
        byte[] buf;
        (buf = new byte[4])[0] = (byte)iSource;
        buf[1] = (byte)(iSource >> 8);
        buf[2] = (byte)(iSource >> 16);
        buf[3] = (byte)(iSource >> 24);
        return buf;
    }

    public static byte[] int2byteLe(int iSource) {
        byte[] buf;
        (buf = new byte[1])[0] = (byte)iSource;
        return buf;
    }

    public static byte intTobyteLe(int iSource) {
        return (byte)iSource;
    }

    public static byte[] int2bytesLe(int iSource, byte[] buf, int offset) {
        buf[offset] = (byte)iSource;
        buf[offset + 1] = (byte)(iSource >> 8);
        buf[offset + 2] = (byte)(iSource >> 16);
        buf[offset + 3] = (byte)(iSource >> 24);
        return buf;
    }

    public static byte char2ByteAscii(char ch) {
        int no;
        return (byte)(no = ch - 65);
    }

    public static char byte2char(byte ch) {
        char no;
        return no = (char)(ch + 65);
    }

    public static byte[] bytes2Bytes_LE(byte[] buf) {
        byte[] rst = new byte[buf.length];

        for(int i = 0; i < buf.length; ++i) {
            rst[i] = buf[buf.length - i - 1];
        }

        return rst;
    }

    public static byte[] bytes2Bytes_BE(byte[] buf) {
        byte[] rst = new byte[buf.length];

        for(int i = 0; i < buf.length; ++i) {
            rst[buf.length - i - 1] = buf[i];
        }

        return rst;
    }

    public static byte[] userId2bytes(String userId) {
        byte[] data = new byte[32];
        byte[] obj;
        System.arraycopy(obj = hexString2Bytes(string2HexString(userId)), 0, data, 0, obj.length);

        for(int i = obj.length; i < 32; ++i) {
            data[i] = 0;
        }

        return data;
    }

    public static String bytes2userId(byte[] buf) {
        int len = 0;

        for(int i = 0; i < buf.length; ++i) {
            if (buf[i] != 0) {
                ++len;
            }
        }

        byte[] data = new byte[len];
        System.arraycopy(buf, 0, data, 0, data.length);
        return hexString2String(bytes2HexString(data));
    }

    public static String bytes2orgCode(byte[] buf) {
        int len = 0;

        for(int i = 0; i < buf.length; ++i) {
            if (buf[i] != 0) {
                ++len;
            }
        }

        byte[] data = new byte[len];
        System.arraycopy(buf, 0, data, 0, data.length);
        return hexString2String(bytes2HexString(data));
    }

    public static String bytes2EquipmentModel(byte[] buf) {
        int len = 0;

        for(int i = 0; i < buf.length; ++i) {
            if (buf[i] != 0) {
                ++len;
            }
        }

        byte[] data = new byte[len];
        System.arraycopy(buf, 0, data, 0, data.length);
        return hexString2String(bytes2HexString(data));
    }

    public static byte[] plate2bytes(String plate) throws Exception {
        byte[] buf;
        Arrays.fill(buf = new byte[9], (byte)0);
        if (StringUtils.isNotBlank(plate)) {
            byte[] data1 = bytes2Bytes_LE(plate.substring(0, 1).getBytes("GB2312"));
            byte[] data2 = hexString2Bytes(string2HexString(plate.substring(1, plate.length())));
            System.arraycopy(data1, 0, buf, 0, data1.length);
            System.arraycopy(data2, 0, buf, data1.length, data2.length);
        }

        return buf;
    }

    public static String bytes2plate(byte[] buf) throws Exception {
        String plate = "";
        if (buf != null && buf.length == 9) {
            if (buf[0] == 0 && buf[1] == 0) {
                return plate;
            } else {
                byte[] data1 = new byte[2];
                System.arraycopy(buf, 0, data1, 0, 2);
                data1 = bytes2Bytes_BE(data1);
                byte[] data2;
                if (buf[8] == 0) {
                    data2 = new byte[6];
                } else {
                    data2 = new byte[7];
                }

                System.arraycopy(buf, data1.length, data2, 0, data2.length);
                return plate + new String(data1, "GB2312") + hexString2String(bytes2HexString(data2));
            }
        } else {
            throw new Exception("plate数据,数据长度错误");
        }
    }

    public static String bytes2VIN(byte[] buf) throws Exception {
        if (buf != null && buf.length == 17) {
            String vin = "";
            boolean isTrue = false;

            for(int i = 0; i < buf.length; ++i) {
                int value;
                if ((value = getUnsignedByte(buf[i])) >= 48 && value <= 57 || value >= 65 && value <= 90 || value >= 97 && value <= 122) {
                    isTrue = true;
                    break;
                }
            }

            if (isTrue) {
                vin = hexString2String(bytes2HexString(buf));
            }

            return vin;
        } else {
            throw new Exception("VIN数据,数据长度错误");
        }
    }

    public static byte[] cardNo2bytes(String cardNo) {
        byte[] data = new byte[16];
        byte[] obj;
        System.arraycopy(obj = hexString2Bytes(string2HexString(cardNo)), 0, data, 0, obj.length);

        for(int i = obj.length; i < 16; ++i) {
            data[i] = 0;
        }

        return data;
    }

    public static String bytes2CardNo(byte[] buf) throws Exception {
        if (buf != null && buf.length == 16) {
            int m = 16;

            for(int i = 0; i < buf.length; ++i) {
                if (buf[i] == 0) {
                    m = i;
                    break;
                }
            }

            byte[] data = new byte[m];
            System.arraycopy(buf, 0, data, 0, data.length);
            return hexString2String(bytes2HexString(data));
        } else {
            throw new Exception("数据,数据长度错误");
        }
    }

    public static String bytes2SecretKey(byte[] buf) throws Exception {
        if (buf != null && buf.length == 16) {
            int m = 0;

            for(int i = 0; i < buf.length; ++i) {
                if (buf[i] == 0) {
                    m = i;
                    break;
                }
            }

            byte[] data = new byte[m];
            System.arraycopy(buf, 0, data, 0, data.length);
            return hexString2String(bytes2HexString(data));
        } else {
            throw new Exception("数据,数据长度错误");
        }
    }

    public static String bytes2ServerAddress(byte[] buf) throws Exception {
        if (buf != null && buf.length == 50) {
            int m = 0;

            for(int i = 0; i < buf.length; ++i) {
                if (buf[i] == 0) {
                    m = i;
                    break;
                }
            }

            byte[] data = new byte[m];
            System.arraycopy(buf, 0, data, 0, data.length);
            return hexString2String(bytes2HexString(data));
        } else {
            throw new Exception("数据,数据长度错误");
        }
    }

    public static String bytes2BrmVer(byte[] buf) throws Exception {
        if (buf != null && buf.length == 3) {
            byte[] brmVer1 = new byte[]{buf[2], buf[1]};
            byte brmVer2 = buf[0];
            int v1 = Integer.parseInt(bytes2HexString(brmVer1), 16);
            int v2 = getUnsignedByte(brmVer2);
            return "V" + v1 + "." + v2;
        } else {
            throw new Exception("brmVer数据,数据长度错误");
        }
    }

    public static String bytes2BrmSoftVer(byte[] buf) throws Exception {
        if (buf != null && buf.length == 8) {
            String stringAuthCode = bytes2HexString(new byte[]{buf[7], buf[6], buf[5]});
            boolean flag = true;
            if ("FFFFFF".equalsIgnoreCase(stringAuthCode)) {
                flag = false;
            }

            int year = Integer.parseInt(bytes2HexString(new byte[]{buf[4], buf[3]}), 16);
            int month = getUnsignedByte(buf[2]);
            int day = getUnsignedByte(buf[1]);
            int times = getUnsignedByte(buf[0]);
            String brmSoftVer;
            if (flag) {
                int authCode = Integer.parseInt(stringAuthCode, 16);
                String pattern = "%s年%s月%s日第%s次编译版本，认证授权码：%s";
                brmSoftVer = String.format("%s年%s月%s日第%s次编译版本，认证授权码：%s", year, month, day, times, authCode);
            } else {
                String pattern = "%s年%s月%s日第%s次编译版本，未填写认证授权码";
                brmSoftVer = String.format("%s年%s月%s日第%s次编译版本，未填写认证授权码", year, month, day, times);
            }

            return brmSoftVer;
        } else {
            throw new Exception("brmSoftVer数据,数据长度错误");
        }
    }

    public static byte bit2byteLE(String bString) {
        byte result = 0;
        int i = 0;

        for(int j = 0; i < bString.length(); ++j) {
            result = (byte)((int)((double)result + (double)Byte.parseByte("" + bString.charAt(i)) * Math.pow((double)2.0F, (double)j)));
            ++i;
        }

        return result;
    }

    public static byte bit2byteBE(String bString) {
        byte result = 0;
        int i = bString.length() - 1;

        for(int j = 0; i >= 0; ++j) {
            result = (byte)((int)((double)result + (double)Byte.parseByte("" + bString.charAt(i)) * Math.pow((double)2.0F, (double)j)));
            --i;
        }

        return result;
    }

    public static String byteToBitBE(byte b) {
        return "" + (byte)(b >> 7 & 1) + (byte)(b >> 6 & 1) + (byte)(b >> 5 & 1) + (byte)(b >> 4 & 1) + (byte)(b >> 3 & 1) + (byte)(b >> 2 & 1) + (byte)(b >> 1 & 1) + (byte)(b >> 0 & 1);
    }

    public static String byteToBitLE(byte b) {
        return "" + (byte)(b >> 0 & 1) + (byte)(b >> 1 & 1) + (byte)(b >> 2 & 1) + (byte)(b >> 3 & 1) + (byte)(b >> 4 & 1) + (byte)(b >> 5 & 1) + (byte)(b >> 6 & 1) + (byte)(b >> 7 & 1);
    }

    public static byte[] orderNo2bytes(String orderNo) {
        byte[] data = new byte[32];
        byte[] obj = new byte[0];
        if (!CommUtils.isEmpty(orderNo)) {
            obj = hexString2Bytes(string2HexString(orderNo));
        }

        System.arraycopy(obj, 0, data, 0, obj.length);

        for(int i = obj.length; i < 32; ++i) {
            data[i] = 0;
        }

        return data;
    }

    public static String bytes2orderNo(byte[] buf) {
        int len = 0;

        for(int i = 0; i < buf.length; ++i) {
            if (buf[i] != 0) {
                ++len;
            }
        }

        byte[] data = new byte[len];
        System.arraycopy(buf, 0, data, 0, data.length);
        return hexString2String(bytes2HexString(data));
    }

    public static byte[] connectorCode2bytes(String connectorCode) {
        byte[] data = new byte[20];
        byte[] obj;
        System.arraycopy(obj = hexString2Bytes(string2HexString(connectorCode)), 0, data, 0, obj.length);

        for(int i = obj.length; i < 20; ++i) {
            data[i] = 0;
        }

        return data;
    }

    public static byte[] qrCode2bytes(String qrCode) {
        byte[] data = new byte[100];
        byte[] obj;
        System.arraycopy(obj = hexString2Bytes(string2HexString(qrCode)), 0, data, 0, obj.length);

        for(int i = obj.length; i < 100; ++i) {
            data[i] = 0;
        }

        return data;
    }

    public static byte[] host2bytes(String host) {
        byte[] data = new byte[100];
        byte[] obj;
        System.arraycopy(obj = hexString2Bytes(string2HexString(host)), 0, data, 0, obj.length);

        for(int i = obj.length; i < 100; ++i) {
            data[i] = 0;
        }

        return data;
    }

    public static int byte4BitLeBefore(byte b) {
        return b & 15;
    }

    public static int byte4BitLeAfter(byte b) {
        return (b & 240) >> 4;
    }

    public static byte decodeBinaryString(String byteStr) {
        if (byteStr == null) {
            return 0;
        } else {
            int len;
            if ((len = byteStr.length()) != 4 && len != 8) {
                return 0;
            } else {
                int re;
                if (len == 8 && byteStr.charAt(0) != '0') {
                    re = Integer.parseInt(byteStr, 2) - 256;
                } else {
                    re = Integer.parseInt(byteStr, 2);
                }

                return (byte)re;
            }
        }
    }

    public static void main(String[] args) {
        System.out.println("ss=" + bytes2shortLe(short2byteLe(1255)));
        byte[] bytes = short2byteLe(1255);
        short aaa = (short)(255 & bytes[0] | '\uff00' & bytes[1] << 8);
        System.out.println("cccc=" + aaa);
        String a = string2HexString("JX");
        System.out.println(a);
        String b = hexString2String(a);
        System.out.println(b);
        byte[] c = hexString2Bytes(a);
        System.out.println(c);
        System.out.println("------------------");
        String d;
        String e = hexString2String(d = string2HexString("JX"));
        String f = bytes2HexString(hexString2Bytes(d));
        System.out.println(d);
        System.out.println(e);
        System.out.println(f);
        System.err.println(Integer.toHexString(200));
        System.err.println(Integer.parseInt("8C", 16));
        System.out.println("len=" + 32);
        System.out.println("----=" + hexString2String("2B7E151628AED2A6ABF7158809CF4F3C"));
        System.err.println(date2Hex("120316200419"));
        System.err.println(hex2Date(date2Hex("120316200419")));
        System.out.println("10:" + intToHexString(1, 2));
        byte[] a2 = str2Bcd("0123");
        System.out.println(bcd2Str(a2));
        System.err.println("心跳超时次数=" + bytes2HexString((byte)-1));
        System.out.println("ss=" + getUnsignedByte((byte)1));
        System.out.println("-----------------------");
        byte[] bb = null;

        try {
            bb = "沪".getBytes("GB2312");
        } catch (UnsupportedEncodingException var18) {
            var18.printStackTrace();
        }

        byte[] cc = bytes2Bytes_LE(bb);
        System.out.println(bytes2HexString(cc) + string2HexString("A12345"));
        String userId = "oPKUxs_MSXXPLD1g886Gx0kZbSms";
        byte[] gh = userId2bytes("oPKUxs_MSXXPLD1g886Gx0kZbSms");
        System.out.println("userid=" + bytes2userId(gh));
        System.out.println(gh.length);
        String plate = "沪DH4592";

        try {
            byte[] aa = plate2bytes(plate);
            System.out.println("车牌号=" + bytes2plate(aa));
            System.out.println(aa.length);
        } catch (Exception var17) {
        }
    }
}
