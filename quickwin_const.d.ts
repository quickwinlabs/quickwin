declare module "gui" {

    export const enum GetWindowCmd {
        FIRST = 0, // 0x0
        LAST = 1, // 0x1
        NEXT = 2, // 0x2
        PREV = 3, // 0x3
        OWNER = 4, // 0x4
        CHILD = 5, // 0x5
    }

    export const enum SetWindowPosFlag {
        SWP_NOSIZE = 1, // 0x1
        SWP_NOMOVE = 2, // 0x2
        SWP_NOZORDER = 4, // 0x4
        SWP_NOACTIVATE = 16, // 0x10
        SWP_SHOWWINDOW = 64, // 0x40
        SWP_HIDEWINDOW = 128, // 0x80
        SWP_FRAMECHANGED = 32, // 0x20
    }

    export const enum NotifyIconCmd {
        ADD = 0, // 0x0
        MODIFY = 1, // 0x1
        DELETE = 2, // 0x2
    }

    export const enum NotifyIconFlag {
        MESSAGE = 1, // 0x1
        ICON = 2, // 0x2
        TIP = 4, // 0x4
    }

    export const enum MenuFlag {
        STRING = 0, // 0x0
        SEPARATOR = 2048, // 0x800
        CHECKED = 8, // 0x8
        GRAYED = 1, // 0x1
        DISABLED = 2, // 0x2
        POPUP = 16, // 0x10
    }

    export const enum WindowStyle {
        OVERLAPPEDWINDOW = 13565952, // 0xCF0000
        CHILD = 1073741824, // 0x40000000
        POPUP = -2147483648, // 0x80000000
        VISIBLE = 268435456, // 0x10000000
        BORDER = 8388608, // 0x800000
        HSCROLL = 1048576, // 0x100000
        VSCROLL = 2097152, // 0x200000
        CLIPCHILDREN = 33554432, // 0x2000000
        TABSTOP = 65536, // 0x10000
        GROUP = 131072, // 0x20000
    }

    export const enum WmMsg {
        CREATE = 1, // 0x1
        DESTROY = 2, // 0x2
        CLOSE = 16, // 0x10
        QUIT = 18, // 0x12
        PAINT = 15, // 0xF
        COMMAND = 273, // 0x111
        SIZE = 5, // 0x5
        CHAR = 258, // 0x102
        KEYDOWN = 256, // 0x100
        KEYUP = 257, // 0x101
        MOUSEMOVE = 512, // 0x200
        LBUTTONDOWN = 513, // 0x201
        LBUTTONUP = 514, // 0x202
        LBUTTONDBLCLK = 515, // 0x203
        RBUTTONDOWN = 516, // 0x204
        RBUTTONUP = 517, // 0x205
        SETFONT = 48, // 0x30
        HSCROLL = 276, // 0x114
        VSCROLL = 277, // 0x115
        MOUSEWHEEL = 522, // 0x20A
        NOTIFY = 78, // 0x4E
        NCHITTEST = 132, // 0x84
        NCLBUTTONDOWN = 161, // 0xA1
        ERASEBKGND = 20, // 0x14
    }

    export const enum ScrollBar {
        HORZ = 0, // 0x0
        VERT = 1, // 0x1
    }

    export const enum ScrollCmd {
        LINEUP = 0, // 0x0
        LINEDOWN = 1, // 0x1
        PAGEUP = 2, // 0x2
        PAGEDOWN = 3, // 0x3
        THUMBTRACK = 5, // 0x5
        THUMBPOSITION = 4, // 0x4
        TOP = 6, // 0x6
        BOTTOM = 7, // 0x7
        ENDSCROLL = 8, // 0x8
    }

    export const enum ScrollInfoFlag {
        RANGE = 1, // 0x1
        PAGE = 2, // 0x2
        POS = 4, // 0x4
        ALL = 23, // 0x17
    }

    export const enum SysMetrics {
        CXSCREEN = 0, // 0x0
        CYSCREEN = 1, // 0x1
    }

    export const enum ButtonStyle {
        PUSHBUTTON = 0, // 0x0
        DEFPUSHBUTTON = 1, // 0x1
        CHECKBOX = 2, // 0x2
        AUTOCHECKBOX = 3, // 0x3
        AUTORADIOBUTTON = 9, // 0x9
        GROUPBOX = 7, // 0x7
    }

    export const enum MouseKeyFlag {
        MK_SHIFT = 4, // 0x4
    }

    export const enum LbMsg {
        ADDSTRING = 384, // 0x180
        INSERTSTRING = 385, // 0x181
        DELETESTRING = 386, // 0x182
        RESETCONTENT = 388, // 0x184
        SETTOPINDEX = 407, // 0x197
        SETCURSEL = 390, // 0x186
        GETCURSEL = 392, // 0x188
        GETTEXT = 393, // 0x189
        GETTEXTLEN = 394, // 0x18A
        GETCOUNT = 395, // 0x18B
    }

    export const enum StaticStyle {
        LEFT = 0, // 0x0
    }

    export const enum EditStyle {
        LEFT = 0, // 0x0
        MULTILINE = 4, // 0x4
        PASSWORD = 32, // 0x20
        AUTOVSCROLL = 64, // 0x40
        AUTOHSCROLL = 128, // 0x80
        READONLY = 2048, // 0x800
        WANTRETURN = 4096, // 0x1000
        NUMBER = 8192, // 0x2000
    }

    export const enum ComboBoxStyle {
        DROPDOWNLIST = 3, // 0x3
        HASSTRINGS = 512, // 0x200
    }

    export const enum ListBoxStyle {
        NOTIFY = 1, // 0x1
        SORT = 2, // 0x2
        MULTIPLESEL = 8, // 0x8
        HASSTRINGS = 64, // 0x40
        NOINTEGRALHEIGHT = 256, // 0x100
        EXTENDEDSEL = 2048, // 0x800
        STANDARD = 10485763, // 0xA00003
    }

    export const enum LbnCode {
        SELCHANGE = 1, // 0x1
    }

    export const enum TabStyle {
        FOCUSNEVER = 32768, // 0x8000
        FIXEDWIDTH = 1024, // 0x400
    }

    export const enum TcMsg {
        GETITEMCOUNT = 4868, // 0x1304
        INSERTITEMW = 4926, // 0x133E
        DELETEITEM = 4872, // 0x1308
        DELETEALLITEMS = 4873, // 0x1309
        GETCURSEL = 4875, // 0x130B
        SETCURSEL = 4876, // 0x130C
    }

    export const enum TcNotifyCode {
        SELCHANGE = -551, // 0xFFFFFDD9
    }

    export const enum ListViewStyle {
        REPORT = 1, // 0x1
        SINGLESEL = 4, // 0x4
        SHOWSELALWAYS = 8, // 0x8
        NOSORTHEADER = 32768, // 0x8000
    }

    export const enum LvExStyle {
        GRIDLINES = 1, // 0x1
        CHECKBOXES = 4, // 0x4
        TRACKSELECT = 8, // 0x8
        HEADERDRAGDROP = 16, // 0x10
        FULLROWSELECT = 32, // 0x20
        DOUBLEBUFFER = 65536, // 0x10000
    }

    export const enum LvMsg {
        GETITEMCOUNT = 4100, // 0x1004
        DELETEALLITEMS = 4105, // 0x1009
        GETNEXTITEM = 4108, // 0x100C
        GETITEMSTATE = 4140, // 0x102C
        SETITEMSTATE = 4139, // 0x102B
        GETSELECTEDCOUNT = 4146, // 0x1032
        SETEXTENDEDLISTVIEWSTYLE = 4150, // 0x1036
        INSERTCOLUMNW = 4193, // 0x1061
        GETSELECTIONMARK = 4162, // 0x1042
        INSERTITEMW = 4173, // 0x104D
        SETITEMW = 4172, // 0x104C
        ENSUREVISIBLE = 4115, // 0x1013
        SETCOLUMNWIDTH = 4126, // 0x101E
        DELETECOLUMN = 4124, // 0x101C
    }

    export const enum LvNotifyCode {
        ITEMCHANGED = -101, // 0xFFFFFF9B
    }

    export const enum ShowWindowCmd {
        HIDE = 0, // 0x0
        SHOW = 5, // 0x5
    }

    export const enum ButtonMsg {
        GETCHECK = 240, // 0xF0
        SETCHECK = 241, // 0xF1
    }

    export const enum ButtonCheckState {
        UNCHECKED = 0, // 0x0
        CHECKED = 1, // 0x1
    }

    export const enum EditMsg {
        GETSEL = 176, // 0xB0
        SETSEL = 177, // 0xB1
        SETCUEBANNER = 5377, // 0x1501
        SETPASSWORDCHAR = 204, // 0xCC
    }

    export const enum EditNotify {
        CHANGE = 768, // 0x300
    }

    export const enum ComboBoxMsg {
        ADDSTRING = 323, // 0x143
        SETCURSEL = 334, // 0x14E
        GETCURSEL = 327, // 0x147
        DELETESTRING = 324, // 0x144
        RESETCONTENT = 331, // 0x14B
        GETCOUNT = 326, // 0x146
        GETLBTEXT = 328, // 0x148
        GETLBTEXTLEN = 329, // 0x149
    }

    export const enum CbnCode {
        SELCHANGE = 1, // 0x1
    }

    export const enum ProgressMsg {
        SETRANGE32 = 1030, // 0x406
        SETPOS = 1026, // 0x402
    }

    export const enum ProgressStyle {
        SMOOTH = 1, // 0x1
    }

    export const enum TrackBarStyle {
        HORZ = 0, // 0x0
        VERT = 2, // 0x2
        AUTOTICKS = 1, // 0x1
        TOOLTIPS = 256, // 0x100
        NOTICKS = 16, // 0x10
    }

    export const enum TbMsg {
        GETPOS = 1024, // 0x400
        SETPOS = 1029, // 0x405
        GETRANGEMIN = 1025, // 0x401
        GETRANGEMAX = 1026, // 0x402
        SETRANGE = 1030, // 0x406
        SETLINESIZE = 1047, // 0x417
        SETPAGESIZE = 1045, // 0x415
    }

    export const enum DtStyle {
        SHORTDATEFORMAT = 0, // 0x0
        LONGDATEFORMAT = 4, // 0x4
        TIMEFORMAT = 9, // 0x9
        UPDOWN = 1, // 0x1
        SHOWNONE = 2, // 0x2
    }

    export const enum DtMsg {
        GETSYSTEMTIME = 4097, // 0x1001
        SETSYSTEMTIME = 4098, // 0x1002
        SETFORMATW = 4146, // 0x1032
    }

    export const enum DtNotifyCode {
        DATETIMECHANGE = -759, // 0xFFFFFD09
    }

    export const enum DtFlag {
        GDT_VALID = 0, // 0x0
        GDT_NONE = 1, // 0x1
    }

    export const enum TreeViewStyle {
        HASBUTTONS = 1, // 0x1
        HASLINES = 2, // 0x2
        LINESATROOT = 4, // 0x4
        SHOWSELALWAYS = 32, // 0x20
        CHECKBOXES = 256, // 0x100
        NOTOOLTIPS = 128, // 0x80
        TRACKSELECT = 512, // 0x200
    }

    export const enum TvMsg {
        INSERTITEMW = 4402, // 0x1132
        DELETEITEM = 4353, // 0x1101
        EXPAND = 4354, // 0x1102
        GETNEXTITEM = 4362, // 0x110A
        SELECTITEM = 4363, // 0x110B
        GETITEMW = 4414, // 0x113E
        SETITEMW = 4415, // 0x113F
        GETCOUNT = 4357, // 0x1105
        ENSUREVISIBLE = 4372, // 0x1114
        SETITEMHEIGHT = 4379, // 0x111B
        SETEXTENDEDSTYLE = 4396, // 0x112C
    }

    export const enum TvExStyle {
        DOUBLEBUFFER = 4, // 0x4
    }

    export const enum TvNotifyCode {
        SELCHANGEDW = -451, // 0xFFFFFE3D
        ITEMEXPANDEDW = -455, // 0xFFFFFE39
        ITEMEXPANDINGW = -454, // 0xFFFFFE3A
    }

    export const enum TvExpandCmd {
        COLLAPSE = 1, // 0x1
        EXPAND = 2, // 0x2
        TOGGLE = 3, // 0x3
        COLLAPSERESET = 32768, // 0x8000
    }

    export const enum TvIfFlag {
        TEXT = 1, // 0x1
        IMAGE = 2, // 0x2
        SELECTEDIMAGE = 32, // 0x20
        STATE = 8, // 0x8
        CHILDREN = 64, // 0x40
        PARAM = 4, // 0x4
        HANDLE = 16, // 0x10
    }

    export const enum TvGnRelative {
        ROOT = 0, // 0x0
        NEXT = 1, // 0x1
        PREVIOUS = 2, // 0x2
        PARENT = 3, // 0x3
        CHILD = 4, // 0x4
        FIRSTVISIBLE = 5, // 0x5
        LASTVISIBLE = 10, // 0xA
        CARET = 9, // 0x9
        DROPHILITE = 8, // 0x8
    }

    // GetWindowLongPtr/GWL 索引
    export const enum Gwlp {
        WNDPROC = -4, // 0xFFFFFFFC
        HINSTANCE = -6, // 0xFFFFFFFA
        HWNDPARENT = -8, // 0xFFFFFFF8
        USERDATA = -21, // 0xFFFFFFEB
        ID = -12, // 0xFFFFFFF4
        STYLE = -16, // 0xFFFFFFF0
    }

    export const enum SysLinkMsg {
        GETIDEALHEIGHT = 1793, // 0x701
        SETITEM = 1794, // 0x702
        GETITEM = 1795, // 0x703
        HITTEST = 1792, // 0x700
    }

    export const enum SysLinkNotifyCode {
        CLICK = -2, // 0xFFFFFFFE
        RETURN = -4, // 0xFFFFFFFC
    }

    export const enum LinkStyle {
        IGNORERETURN = 2, // 0x2
        TRANSPARENT = 1, // 0x1
        USEVISUALSTYLE = 8, // 0x8
    }

    export const enum TtMsg {
        ACTIVATE = 1025, // 0x401
        ADDTOOLW = 1074, // 0x432
        DELTOOLW = 1075, // 0x433
        SETTOOLINFOW = 1078, // 0x436
        UPDATETIPTEXTW = 1081, // 0x439
        SETMAXTIPWIDTH = 1048, // 0x418
        SETDELAYTIME = 1027, // 0x403
        POPUP = 1058, // 0x422
    }

    export const enum TooltipStyle {
        ALWAYSTIP = 1, // 0x1
        NOPREFIX = 2, // 0x2
        BALLOON = 64, // 0x40
        CLOSE = 128, // 0x80
        USEVISUALSTYLE = 256, // 0x100
    }

    export const enum TtToolFlag {
        SUBCLASS = 16, // 0x10
        IDISHWND = 1, // 0x1
        CENTERTIP = 2, // 0x2
        TRACK = 32, // 0x20
        ABSOLUTE = 128, // 0x80
        TRANSPARENT = 256, // 0x100
        DI_SETITEM = 32768, // 0x8000
    }

}

declare module "sock" {

    export const enum AddrFamily {
        AF_INET = 2, // 0x2
    }

    export const enum SockType {
        SOCK_STREAM = 1, // 0x1
        SOCK_DGRAM = 2, // 0x2
    }

    export const enum Protocol {
        IPPROTO_TCP = 6, // 0x6
        IPPROTO_UDP = 17, // 0x11
    }

    export const enum Shutdown {
        SD_RECEIVE = 0, // 0x0
        SD_SEND = 1, // 0x1
        SD_BOTH = 2, // 0x2
    }

    export const enum FdEvent {
        FD_READ = 1, // 0x1
        FD_WRITE = 2, // 0x2
        FD_CONNECT = 16, // 0x10
        FD_CLOSE = 32, // 0x20
    }

}

declare module "wolfssl" {

    export const enum VerifyMode {
        SSL_VERIFY_NONE = 0, // 0x0
        SSL_VERIFY_PEER = 1, // 0x1
    }

    export const enum SniType {
        WOLFSSL_SNI_HOST_NAME = 0, // 0x0
    }

    export const enum FileType {
        SSL_FILETYPE_PEM = 1, // 0x1
    }

    export const enum ReturnCode {
        SSL_SUCCESS = 1, // 0x1
    }

    export const enum ErrorCode {
        WOLFSSL_ERROR_WANT_READ = 2, // 0x2
        WOLFSSL_ERROR_WANT_WRITE = 3, // 0x3
    }

}
