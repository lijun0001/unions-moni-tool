//
// Source code recreated from a .class file by IntelliJ IDEA
// (powered by Fernflower decompiler)
//

package com.enneagon.v5.util;

import com.enneagon.v5.annotation.NotProguard;
import com.enneagon.v5.constant.SysConst;
import com.enneagon.v5.message.BaseMessage;
import io.netty.buffer.ByteBufUtil;
import io.netty.channel.Channel;
import io.netty.util.AttributeKey;
import java.lang.reflect.Array;
import java.math.BigDecimal;
import java.text.MessageFormat;
import java.text.ParseException;
import java.text.SimpleDateFormat;
import java.util.Calendar;
import java.util.Collection;
import java.util.Date;
import java.util.Map;
import org.apache.commons.lang3.StringUtils;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

@NotProguard
public class CommUtils {
    private static final Logger LOG = LoggerFactory.getLogger(CommUtils.class);

    public CommUtils() {
    }

    public static void setSecureKeyAttr(Channel channel, String secureKey) {
        channel.attr(SysConst.SECURE_KEY).set(secureKey);
    }

    public static String getSecureKeyFromAttr(Channel channel) {
        String key;
        if (StringUtils.isBlank(key = (String)channel.attr(SysConst.SECURE_KEY).get())) {
            LOG.error("key为空");
        }

        LOG.info("=========key======" + key);
        return key;
    }

    public static void setMacAttr(Channel channel, String mac) {
        channel.attr(SysConst.MAC_KEY).set(mac);
    }

    public static String getMacFromAttr(Channel channel) {
        return (String)channel.attr(SysConst.MAC_KEY).get();
    }

    public static void setKeyAttr(Channel channel, AttributeKey<String> key, String value) {
        channel.attr(key).set(value);
    }

    public static String getKeyFromAttr(Channel channel, AttributeKey<String> key) {
        return (String)channel.attr(key).get();
    }

    public static String getTimeScaleFromByte(byte[] bits) {
        if (bits == null || bits.length < 6) {
            LOG.error("获取TimeScale,数据长度错误");
        }

        byte[] obj = copyBytes(bits, 0, 0, 6);
        System.arraycopy(bits, 0, obj, 0, obj.length);
        String timeScale = TypeConversion.hex2Date(TypeConversion.bytes2HexString(obj));
        SimpleDateFormat sdf = new SimpleDateFormat("yyMMddHHmmss");
        SimpleDateFormat sdf1 = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss");

        try {
            timeScale = sdf1.format(sdf.parse(timeScale));
        } catch (ParseException var6) {
            var6.printStackTrace();
        }

        return timeScale;
    }

    public static String getStartTimeFromByte(byte[] bits) {
        if (bits == null || bits.length < 6) {
            LOG.error("获取TimeScale,数据长度错误");
        }

        String timeScale = TypeConversion.hex2Date(TypeConversion.bytes2HexString(bits));
        SimpleDateFormat sdf = new SimpleDateFormat("yyMMddHHmmss");

        try {
            timeScale = (new SimpleDateFormat("yyyy-MM-dd HH:mm:ss")).format(sdf.parse(timeScale));
        } catch (ParseException var4) {
            var4.printStackTrace();
        }

        return timeScale;
    }

    public static String hex2ForMatDate(String hex) {
        String timeScale = TypeConversion.hex2Date(hex);
        SimpleDateFormat sdf = new SimpleDateFormat("yyMMddHHmmss");
        SimpleDateFormat sdf1 = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss");

        try {
            timeScale = sdf1.format(sdf.parse(timeScale));
        } catch (ParseException var5) {
            var5.printStackTrace();
        }

        return timeScale;
    }

    public static Date hexDate2ForDate(String hex) {
        String timeScale = TypeConversion.hex2Date(hex);
        SimpleDateFormat sdf = new SimpleDateFormat("yyMMddHHmmss");
        Date date = null;

        try {
            date = sdf.parse(timeScale);
        } catch (ParseException var5) {
            var5.printStackTrace();
        }

        return date;
    }

    public static boolean isEffectiveDate(byte[] timeBt, int minute) {
        Date date = hexDate2ForDate(TypeConversion.bytes2HexString(timeBt));
        SimpleDateFormat sdf1 = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss");
        LOG.info("指令时间=" + sdf1.format(date));
        Calendar c1 = Calendar.getInstance();
        Calendar c2 = Calendar.getInstance();
        Calendar c3 = Calendar.getInstance();
        c1.setTime(date);
        c2.setTime(new Date());
        c3.setTime(new Date());
        c3.add(12, minute);
        c2.add(12, -minute);
        boolean flag;
        if (c1.after(c2) && c1.before(c3)) {
            flag = true;
        } else {
            flag = false;
        }

        return flag;
    }

    public static byte[] getTimeScaleByte() {
        return TypeConversion.hexString2Bytes(TypeConversion.date2Hex((String)null));
    }

    public static byte[] getStartTime(String startTime) {
        byte[] timeScale = new byte[6];

        try {
            SimpleDateFormat sdf = new SimpleDateFormat("yyMMddHHmmss");
            SimpleDateFormat sdf1 = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss");
            String date = sdf.format(sdf1.parse(startTime));
            StringBuffer hexString = new StringBuffer();

            for(int i = 0; i < date.length() / 2; ++i) {
                String strHex = TypeConversion.intToHexString(Integer.valueOf(date.substring(i * 2, i * 2 + 2)), 1);
                hexString.append(strHex);
            }

            timeScale = TypeConversion.hexString2Bytes(hexString.toString());
        } catch (Exception var9) {
            var9.printStackTrace();
        }

        return timeScale;
    }

    public static byte[] getOverTimeByte(String overTime) {
        SimpleDateFormat sdf = new SimpleDateFormat("yyMMddHHmmss");
        Calendar cal;
        (cal = Calendar.getInstance()).add(12, Integer.valueOf(overTime));
        String date = sdf.format(cal.getTime());
        StringBuffer hexString = new StringBuffer();

        for(int i = 0; i < date.length() / 2; ++i) {
            String strHex = TypeConversion.intToHexString(Integer.valueOf(date.substring(i * 2, i * 2 + 2)), 1);
            hexString.append(strHex);
        }

        return TypeConversion.hexString2Bytes(hexString.toString());
    }

    public static byte[] copyBytes(byte[] src, int srcPos, int destPos, int length) {
        if (src != null && src.length >= length) {
            byte[] obj = new byte[length];
            System.arraycopy(src, srcPos, obj, destPos, length);
            return obj;
        } else {
            LOG.error("copyBytes数据,数据长度错误");
            return null;
        }
    }

    public static byte[] bytes2Bytes_LE(byte[] buf) {
        byte[] rst = new byte[buf.length];

        for(int i = 0; i < buf.length; ++i) {
            rst[i] = buf[buf.length - i - 1];
        }

        return rst;
    }

    public static byte[] byteMerger(byte[]... bts) {
        int len = 0;
        int destPos = 0;

        for(byte[] bs : bts) {
            len += bs.length;
        }

        byte[] bt = new byte[len];
        byte[][] var9 = bts;
        int var10 = bts.length;

        for(int var11 = 0; var11 < var10; ++var11) {
            byte[] bs;
            System.arraycopy(bs = var9[var11], 0, bt, destPos, bs.length);
            destPos += bs.length;
        }

        return bt;
    }

    public static byte[] xorBytes(byte[] src) {
        if (src == null || src.length != 16) {
            LOG.error("xorBytes数据,数据长度错误");
        }

        byte[] obj = new byte[8];

        for(int i = 0; i < 8; ++i) {
            byte a = src[i * 2];
            byte b = src[i * 2 + 1];
            obj[i] = (byte)(a ^ b);
        }

        return obj;
    }

    public static void printLog(Logger LOG, BaseMessage msg) throws Exception {
        String chargerNo = msg.getDeviceCode();
        LOG.info(MessageFormat.format("event={0},chargerNo={1},data={2}", TypeConversion.bytes2HexString(msg.getCommand()), chargerNo, ByteBufUtil.hexDump(msg.getData().toBytes())));
    }

    public static long getOverTime(byte[] buf) {
        String timeScale = TypeConversion.hex2Date(TypeConversion.bytes2HexString(buf));
        SimpleDateFormat sdf = new SimpleDateFormat("yyMMddHHmmss");
        Date overTime = null;

        try {
            overTime = sdf.parse(timeScale);
        } catch (ParseException var8) {
            var8.printStackTrace();
        }

        long seconds;
        return (seconds = (overTime.getTime() - Calendar.getInstance().getTime().getTime()) / 1000L) < 0L ? 0L : seconds;
    }

    public static String getBookingOrder(String connectorCode) {
        SimpleDateFormat sdf1 = new SimpleDateFormat("yyyyMMddHHmmss");
        return connectorCode + sdf1.format(Calendar.getInstance().getTime());
    }

    public static boolean isEmpty(Object obj) {
        if (obj == null) {
            return true;
        } else if (obj instanceof String) {
            return ((String)obj).trim().isEmpty();
        } else if (obj instanceof Collection) {
            return ((Collection)obj).size() == 0;
        } else if (obj instanceof Map) {
            return ((Map)obj).size() == 0;
        } else if (obj.getClass().isArray()) {
            return Array.getLength(obj) == 0;
        } else {
            return false;
        }
    }

    public static BigDecimal round(BigDecimal f1, BigDecimal f2, int scale, int rundType) {
        BigDecimal rs = null;
        f1 = isEmpty(f1) ? new BigDecimal("0.000") : f1;
        f2 = isEmpty(f2) ? new BigDecimal("0.000") : f2;
        switch (rundType) {
            case 0:
                rs = f1.add(f2);
                break;
            case 1:
                rs = f1.subtract(f2);
                break;
            case 2:
                rs = f1.multiply(f2);
                break;
            case 3:
                rs = f1.divide(f2, scale, 4);
        }

        return rs.divide(new BigDecimal(1), scale, 4);
    }

    public static void main(String[] args) {
        byte[] bt1;
        (bt1 = new byte[2])[0] = 1;
        bt1[1] = 2;
        byte[] bt2;
        (bt2 = new byte[3])[0] = 3;
        bt2[1] = 4;
        bt2[2] = 5;
        byte[] bt3;
        (bt3 = new byte[4])[0] = 6;
        bt3[1] = 7;
        bt3[2] = 8;
        bt3[3] = 9;
        byte[] bb = byteMerger(bt1, bt2, bt3);
        System.out.println(bb.length);
    }
}
