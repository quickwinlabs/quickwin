#include <winsock2.h>
#include <windows.h>
#include <commctrl.h>
#include <shellapi.h>
#include <wolfssl/options.h>
#include <wolfssl/ssl.h>
#include <stdio.h>

#define DEC(ts, c) printf("        %s = %d, // 0x%X\n", #ts, (int)(c), (unsigned)(c));

static void print_enums(void) {
    /* gui */
    printf("declare module \"gui\" {\n\n");

    printf("    export const enum GetWindowCmd {\n");
    DEC(FIRST, GW_HWNDFIRST);
    DEC(LAST, GW_HWNDLAST);
    DEC(NEXT, GW_HWNDNEXT);
    DEC(PREV, GW_HWNDPREV);
    DEC(OWNER, GW_OWNER);
    DEC(CHILD, GW_CHILD);
    printf("    }\n\n");

    printf("    export const enum SetWindowPosFlag {\n");
    DEC(SWP_NOSIZE, SWP_NOSIZE);
    DEC(SWP_NOMOVE, SWP_NOMOVE);
    DEC(SWP_NOZORDER, SWP_NOZORDER);
    DEC(SWP_NOACTIVATE, SWP_NOACTIVATE);
    DEC(SWP_SHOWWINDOW, SWP_SHOWWINDOW);
    DEC(SWP_HIDEWINDOW, SWP_HIDEWINDOW);
    DEC(SWP_FRAMECHANGED, SWP_FRAMECHANGED);
    printf("    }\n\n");

    printf("    export const enum NotifyIconCmd {\n");
    DEC(ADD, NIM_ADD);
    DEC(MODIFY, NIM_MODIFY);
    DEC(DELETE, NIM_DELETE);
    printf("    }\n\n");

    printf("    export const enum NotifyIconFlag {\n");
    DEC(MESSAGE, NIF_MESSAGE);
    DEC(ICON, NIF_ICON);
    DEC(TIP, NIF_TIP);
    printf("    }\n\n");

    printf("    export const enum MenuFlag {\n");
    DEC(STRING, MF_STRING);
    DEC(SEPARATOR, MF_SEPARATOR);
    DEC(CHECKED, MF_CHECKED);
    DEC(GRAYED, MF_GRAYED);
    DEC(DISABLED, MF_DISABLED);
    DEC(POPUP, MF_POPUP);
    printf("    }\n\n");

    printf("    export const enum WindowStyle {\n");
    DEC(OVERLAPPEDWINDOW, WS_OVERLAPPEDWINDOW);
    DEC(CHILD, WS_CHILD);
    DEC(POPUP, WS_POPUP);
    DEC(VISIBLE, WS_VISIBLE);
    DEC(BORDER, WS_BORDER);
    DEC(HSCROLL, WS_HSCROLL);
    DEC(VSCROLL, WS_VSCROLL);
    DEC(CLIPCHILDREN, WS_CLIPCHILDREN);
    DEC(TABSTOP, WS_TABSTOP);
    DEC(GROUP, WS_GROUP);
    printf("    }\n\n");

    printf("    export const enum WmMsg {\n");
    DEC(CREATE, WM_CREATE);
    DEC(DESTROY, WM_DESTROY);
    DEC(CLOSE, WM_CLOSE);
    DEC(QUIT, WM_QUIT);
    DEC(PAINT, WM_PAINT);
    DEC(COMMAND, WM_COMMAND);
    DEC(SIZE, WM_SIZE);
    DEC(CHAR, WM_CHAR);
    DEC(KEYDOWN, WM_KEYDOWN);
    DEC(KEYUP, WM_KEYUP);
    DEC(MOUSEMOVE, WM_MOUSEMOVE);
    DEC(LBUTTONDOWN, WM_LBUTTONDOWN);
    DEC(LBUTTONUP, WM_LBUTTONUP);
    DEC(LBUTTONDBLCLK, WM_LBUTTONDBLCLK);
    DEC(RBUTTONDOWN, WM_RBUTTONDOWN);
    DEC(RBUTTONUP, WM_RBUTTONUP);
    DEC(SETFONT, WM_SETFONT);
    DEC(HSCROLL, WM_HSCROLL);
    DEC(VSCROLL, WM_VSCROLL);
    DEC(MOUSEWHEEL, WM_MOUSEWHEEL);
    DEC(NOTIFY, WM_NOTIFY);
    DEC(NCHITTEST, WM_NCHITTEST);
    DEC(NCLBUTTONDOWN, WM_NCLBUTTONDOWN);
    DEC(ERASEBKGND, WM_ERASEBKGND);
    printf("    }\n\n");

    printf("    export const enum ScrollBar {\n");
    DEC(HORZ, SB_HORZ);
    DEC(VERT, SB_VERT);
    printf("    }\n\n");

    printf("    export const enum ScrollCmd {\n");
    DEC(LINEUP, SB_LINEUP);
    DEC(LINEDOWN, SB_LINEDOWN);
    DEC(PAGEUP, SB_PAGEUP);
    DEC(PAGEDOWN, SB_PAGEDOWN);
    DEC(THUMBTRACK, SB_THUMBTRACK);
    DEC(THUMBPOSITION, SB_THUMBPOSITION);
    DEC(TOP, SB_TOP);
    DEC(BOTTOM, SB_BOTTOM);
    DEC(ENDSCROLL, SB_ENDSCROLL);
    printf("    }\n\n");

    printf("    export const enum ScrollInfoFlag {\n");
    DEC(RANGE, SIF_RANGE);
    DEC(PAGE, SIF_PAGE);
    DEC(POS, SIF_POS);
    DEC(ALL, SIF_ALL);
    printf("    }\n\n");

    printf("    export const enum SysMetrics {\n");
    DEC(CXSCREEN, SM_CXSCREEN);
    DEC(CYSCREEN, SM_CYSCREEN);
    printf("    }\n\n");

    printf("    export const enum ButtonStyle {\n");
    DEC(PUSHBUTTON, BS_PUSHBUTTON);
    DEC(DEFPUSHBUTTON, BS_DEFPUSHBUTTON);
    DEC(CHECKBOX, BS_CHECKBOX);
    DEC(AUTOCHECKBOX, BS_AUTOCHECKBOX);
    DEC(AUTORADIOBUTTON, BS_AUTORADIOBUTTON);
    DEC(GROUPBOX, BS_GROUPBOX);
    printf("    }\n\n");

    printf("    export const enum MouseKeyFlag {\n");
    DEC(MK_SHIFT, MK_SHIFT);
    printf("    }\n\n");

    printf("    export const enum LbMsg {\n");
    DEC(ADDSTRING, LB_ADDSTRING);
    DEC(INSERTSTRING, LB_INSERTSTRING);
    DEC(DELETESTRING, LB_DELETESTRING);
    DEC(RESETCONTENT, LB_RESETCONTENT);
    DEC(SETCURSEL, LB_SETCURSEL);
    DEC(GETCURSEL, LB_GETCURSEL);
    DEC(GETTEXT, LB_GETTEXT);
    DEC(GETTEXTLEN, LB_GETTEXTLEN);
    DEC(GETCOUNT, LB_GETCOUNT);
    printf("    }\n\n");

    printf("    export const enum StaticStyle {\n");
    DEC(LEFT, SS_LEFT);
    printf("    }\n\n");

    printf("    export const enum EditStyle {\n");
    DEC(LEFT, ES_LEFT);
    DEC(MULTILINE, ES_MULTILINE);
    DEC(PASSWORD, ES_PASSWORD);
    DEC(AUTOVSCROLL, ES_AUTOVSCROLL);
    DEC(AUTOHSCROLL, ES_AUTOHSCROLL);
    DEC(READONLY, ES_READONLY);
    DEC(WANTRETURN, ES_WANTRETURN);
    DEC(NUMBER, ES_NUMBER);
    printf("    }\n\n");

    printf("    export const enum ComboBoxStyle {\n");
    DEC(DROPDOWNLIST, CBS_DROPDOWNLIST);
    DEC(HASSTRINGS, CBS_HASSTRINGS);
    printf("    }\n\n");

    printf("    export const enum ListBoxStyle {\n");
    DEC(NOTIFY, LBS_NOTIFY);
    DEC(SORT, LBS_SORT);
    DEC(MULTIPLESEL, LBS_MULTIPLESEL);
    DEC(HASSTRINGS, LBS_HASSTRINGS);
    DEC(NOINTEGRALHEIGHT, LBS_NOINTEGRALHEIGHT);
    DEC(EXTENDEDSEL, LBS_EXTENDEDSEL);
    DEC(STANDARD, LBS_STANDARD);
    printf("    }\n\n");

    printf("    export const enum LbnCode {\n");
    DEC(SELCHANGE, LBN_SELCHANGE);
    printf("    }\n\n");

    printf("    export const enum TabStyle {\n");
    DEC(FOCUSNEVER, TCS_FOCUSNEVER);
    DEC(FIXEDWIDTH, TCS_FIXEDWIDTH);
    printf("    }\n\n");

    printf("    export const enum TcMsg {\n");
    DEC(GETITEMCOUNT, TCM_GETITEMCOUNT);
    DEC(INSERTITEMW, TCM_INSERTITEMW);
    DEC(DELETEITEM, TCM_DELETEITEM);
    DEC(DELETEALLITEMS, TCM_DELETEALLITEMS);
    DEC(GETCURSEL, TCM_GETCURSEL);
    DEC(SETCURSEL, TCM_SETCURSEL);
    printf("    }\n\n");

    printf("    export const enum TcNotifyCode {\n");
    DEC(SELCHANGE, TCN_SELCHANGE);
    printf("    }\n\n");

    printf("    export const enum ListViewStyle {\n");
    DEC(REPORT, LVS_REPORT);
    DEC(SINGLESEL, LVS_SINGLESEL);
    DEC(SHOWSELALWAYS, LVS_SHOWSELALWAYS);
    DEC(NOSORTHEADER, LVS_NOSORTHEADER);
    printf("    }\n\n");

    printf("    export const enum LvExStyle {\n");
    DEC(GRIDLINES, LVS_EX_GRIDLINES);
    DEC(CHECKBOXES, LVS_EX_CHECKBOXES);
    DEC(TRACKSELECT, LVS_EX_TRACKSELECT);
    DEC(HEADERDRAGDROP, LVS_EX_HEADERDRAGDROP);
    DEC(FULLROWSELECT, LVS_EX_FULLROWSELECT);
    DEC(DOUBLEBUFFER, LVS_EX_DOUBLEBUFFER);
    printf("    }\n\n");

    printf("    export const enum LvMsg {\n");
    DEC(GETITEMCOUNT, LVM_GETITEMCOUNT);
    DEC(DELETEALLITEMS, LVM_DELETEALLITEMS);
    DEC(GETNEXTITEM, LVM_GETNEXTITEM);
    DEC(GETITEMSTATE, LVM_GETITEMSTATE);
    DEC(SETITEMSTATE, LVM_SETITEMSTATE);
    DEC(GETSELECTEDCOUNT, LVM_GETSELECTEDCOUNT);
    DEC(SETEXTENDEDLISTVIEWSTYLE, LVM_SETEXTENDEDLISTVIEWSTYLE);
    DEC(INSERTCOLUMNW, LVM_INSERTCOLUMNW);
    DEC(GETSELECTIONMARK, LVM_GETSELECTIONMARK);
    DEC(INSERTITEMW, LVM_INSERTITEMW);
    DEC(SETITEMW, LVM_SETITEMW);
    DEC(ENSUREVISIBLE, LVM_ENSUREVISIBLE);
    DEC(SETCOLUMNWIDTH, LVM_SETCOLUMNWIDTH);
    DEC(DELETECOLUMN, LVM_DELETECOLUMN);
    printf("    }\n\n");

    printf("    export const enum LvNotifyCode {\n");
    DEC(ITEMCHANGED, LVN_ITEMCHANGED);
    printf("    }\n\n");

    printf("    export const enum ShowWindowCmd {\n");
    DEC(HIDE, SW_HIDE);
    DEC(SHOW, SW_SHOW);
    printf("    }\n\n");

    printf("    export const enum ButtonMsg {\n");
    DEC(GETCHECK, BM_GETCHECK);
    DEC(SETCHECK, BM_SETCHECK);
    printf("    }\n\n");

    printf("    export const enum ButtonCheckState {\n");
    DEC(UNCHECKED, BST_UNCHECKED);
    DEC(CHECKED, BST_CHECKED);
    printf("    }\n\n");

    printf("    export const enum EditMsg {\n");
    DEC(GETSEL, EM_GETSEL);
    DEC(SETSEL, EM_SETSEL);
    DEC(SETCUEBANNER, EM_SETCUEBANNER);
    DEC(SETPASSWORDCHAR, EM_SETPASSWORDCHAR);
    printf("    }\n\n");

    printf("    export const enum EditNotify {\n");
    DEC(CHANGE, EN_CHANGE);
    printf("    }\n\n");

    printf("    export const enum ComboBoxMsg {\n");
    DEC(ADDSTRING, CB_ADDSTRING);
    DEC(SETCURSEL, CB_SETCURSEL);
    DEC(GETCURSEL, CB_GETCURSEL);
    DEC(DELETESTRING, CB_DELETESTRING);
    DEC(RESETCONTENT, CB_RESETCONTENT);
    DEC(GETCOUNT, CB_GETCOUNT);
    DEC(GETLBTEXT, CB_GETLBTEXT);
    DEC(GETLBTEXTLEN, CB_GETLBTEXTLEN);
    printf("    }\n\n");

    printf("    export const enum CbnCode {\n");
    DEC(SELCHANGE, CBN_SELCHANGE);
    printf("    }\n\n");

    printf("    export const enum ProgressMsg {\n");
    DEC(SETRANGE32, PBM_SETRANGE32);
    DEC(SETPOS, PBM_SETPOS);
    printf("    }\n\n");

    printf("    export const enum ProgressStyle {\n");
    DEC(SMOOTH, PBS_SMOOTH);
    printf("    }\n\n");

    printf("    export const enum TrackBarStyle {\n");
    DEC(HORZ, TBS_HORZ);
    DEC(VERT, TBS_VERT);
    DEC(AUTOTICKS, TBS_AUTOTICKS);
    DEC(TOOLTIPS, TBS_TOOLTIPS);
    DEC(NOTICKS, TBS_NOTICKS);
    printf("    }\n\n");

    printf("    export const enum TbMsg {\n");
    DEC(GETPOS, TBM_GETPOS);
    DEC(SETPOS, TBM_SETPOS);
    DEC(GETRANGEMIN, TBM_GETRANGEMIN);
    DEC(GETRANGEMAX, TBM_GETRANGEMAX);
    DEC(SETRANGE, TBM_SETRANGE);
    DEC(SETLINESIZE, TBM_SETLINESIZE);
    DEC(SETPAGESIZE, TBM_SETPAGESIZE);
    printf("    }\n\n");

    printf("    export const enum DtStyle {\n");
    DEC(SHORTDATEFORMAT, DTS_SHORTDATEFORMAT);
    DEC(LONGDATEFORMAT, DTS_LONGDATEFORMAT);
    DEC(TIMEFORMAT, DTS_TIMEFORMAT);
    DEC(UPDOWN, DTS_UPDOWN);
    DEC(SHOWNONE, DTS_SHOWNONE);
    printf("    }\n\n");

    printf("    export const enum DtMsg {\n");
    DEC(GETSYSTEMTIME, DTM_GETSYSTEMTIME);
    DEC(SETSYSTEMTIME, DTM_SETSYSTEMTIME);
    DEC(SETFORMATW, DTM_SETFORMATW);
    printf("    }\n\n");

    printf("    export const enum DtNotifyCode {\n");
    DEC(DATETIMECHANGE, DTN_DATETIMECHANGE);
    printf("    }\n\n");

    printf("    export const enum DtFlag {\n");
    DEC(GDT_VALID, GDT_VALID);
    DEC(GDT_NONE, GDT_NONE);
    printf("    }\n\n");

    printf("    export const enum TreeViewStyle {\n");
    DEC(HASBUTTONS, TVS_HASBUTTONS);
    DEC(HASLINES, TVS_HASLINES);
    DEC(LINESATROOT, TVS_LINESATROOT);
    DEC(SHOWSELALWAYS, TVS_SHOWSELALWAYS);
    DEC(CHECKBOXES, TVS_CHECKBOXES);
    DEC(NOTOOLTIPS, TVS_NOTOOLTIPS);
    DEC(TRACKSELECT, TVS_TRACKSELECT);
    printf("    }\n\n");

    printf("    export const enum TvMsg {\n");
    DEC(INSERTITEMW, TVM_INSERTITEMW);
    DEC(DELETEITEM, TVM_DELETEITEM);
    DEC(EXPAND, TVM_EXPAND);
    DEC(GETNEXTITEM, TVM_GETNEXTITEM);
    DEC(SELECTITEM, TVM_SELECTITEM);
    DEC(GETITEMW, TVM_GETITEMW);
    DEC(SETITEMW, TVM_SETITEMW);
    DEC(GETCOUNT, TVM_GETCOUNT);
    DEC(ENSUREVISIBLE, TVM_ENSUREVISIBLE);
    DEC(SETITEMHEIGHT, TVM_SETITEMHEIGHT);
    DEC(SETEXTENDEDSTYLE, TVM_SETEXTENDEDSTYLE);
    printf("    }\n\n");

    printf("    export const enum TvExStyle {\n");
    DEC(DOUBLEBUFFER, TVS_EX_DOUBLEBUFFER);
    printf("    }\n\n");

    printf("    export const enum TvNotifyCode {\n");
    DEC(SELCHANGEDW, TVN_SELCHANGEDW);
    DEC(ITEMEXPANDEDW, TVN_ITEMEXPANDEDW);
    DEC(ITEMEXPANDINGW, TVN_ITEMEXPANDINGW);
    printf("    }\n\n");

    printf("    export const enum TvExpandCmd {\n");
    DEC(COLLAPSE, TVE_COLLAPSE);
    DEC(EXPAND, TVE_EXPAND);
    DEC(TOGGLE, TVE_TOGGLE);
    DEC(COLLAPSERESET, TVE_COLLAPSERESET);
    printf("    }\n\n");

    printf("    export const enum TvIfFlag {\n");
    DEC(TEXT, TVIF_TEXT);
    DEC(IMAGE, TVIF_IMAGE);
    DEC(SELECTEDIMAGE, TVIF_SELECTEDIMAGE);
    DEC(STATE, TVIF_STATE);
    DEC(CHILDREN, TVIF_CHILDREN);
    DEC(PARAM, TVIF_PARAM);
    DEC(HANDLE, TVIF_HANDLE);
    printf("    }\n\n");

    printf("    export const enum TvGnRelative {\n");
    DEC(ROOT, TVGN_ROOT);
    DEC(NEXT, TVGN_NEXT);
    DEC(PREVIOUS, TVGN_PREVIOUS);
    DEC(PARENT, TVGN_PARENT);
    DEC(CHILD, TVGN_CHILD);
    DEC(FIRSTVISIBLE, TVGN_FIRSTVISIBLE);
    DEC(LASTVISIBLE, TVGN_LASTVISIBLE);
    DEC(CARET, TVGN_CARET);
    DEC(DROPHILITE, TVGN_DROPHILITE);
    printf("    }\n\n");

    printf("    // GetWindowLongPtr/GWL 索引\n");
    printf("    export const enum Gwlp {\n");
    DEC(WNDPROC, GWLP_WNDPROC);
    DEC(HINSTANCE, GWLP_HINSTANCE);
    DEC(HWNDPARENT, GWLP_HWNDPARENT);
    DEC(USERDATA, GWLP_USERDATA);
    DEC(ID, GWLP_ID);
    DEC(STYLE, GWL_STYLE);
    printf("    }\n\n");

    printf("    export const enum SysLinkMsg {\n");
    DEC(GETIDEALHEIGHT, LM_GETIDEALHEIGHT);
    DEC(SETITEM, LM_SETITEM);
    DEC(GETITEM, LM_GETITEM);
    DEC(HITTEST, LM_HITTEST);
    printf("    }\n\n");

    printf("    export const enum SysLinkNotifyCode {\n");
    DEC(CLICK, NM_CLICK);
    DEC(RETURN, NM_RETURN);
    printf("    }\n\n");

    printf("    export const enum LinkStyle {\n");
    DEC(IGNORERETURN, LWS_IGNORERETURN);
    DEC(TRANSPARENT, LWS_TRANSPARENT);
    DEC(USEVISUALSTYLE, LWS_USEVISUALSTYLE);
    printf("    }\n\n");

    printf("    export const enum TtMsg {\n");
    DEC(ACTIVATE, TTM_ACTIVATE);
    DEC(ADDTOOLW, TTM_ADDTOOLW);
    DEC(DELTOOLW, TTM_DELTOOLW);
    DEC(SETTOOLINFOW, TTM_SETTOOLINFOW);
    DEC(UPDATETIPTEXTW, TTM_UPDATETIPTEXTW);
    DEC(SETMAXTIPWIDTH, TTM_SETMAXTIPWIDTH);
    DEC(SETDELAYTIME, TTM_SETDELAYTIME);
    DEC(POPUP, TTM_POPUP);
    printf("    }\n\n");

    printf("    export const enum TooltipStyle {\n");
    DEC(ALWAYSTIP, TTS_ALWAYSTIP);
    DEC(NOPREFIX, TTS_NOPREFIX);
    DEC(BALLOON, TTS_BALLOON);
    DEC(CLOSE, TTS_CLOSE);
    DEC(USEVISUALSTYLE, TTS_USEVISUALSTYLE);
    printf("    }\n\n");

    printf("    export const enum TtToolFlag {\n");
    DEC(SUBCLASS, TTF_SUBCLASS);
    DEC(IDISHWND, TTF_IDISHWND);
    DEC(CENTERTIP, TTF_CENTERTIP);
    DEC(TRACK, TTF_TRACK);
    DEC(ABSOLUTE, TTF_ABSOLUTE);
    DEC(TRANSPARENT, TTF_TRANSPARENT);
    DEC(DI_SETITEM, TTF_DI_SETITEM);
    printf("    }\n\n");

    printf("}\n\n");

    /* sock */
    printf("declare module \"sock\" {\n\n");

    printf("    export const enum AddrFamily {\n");
    DEC(AF_INET, AF_INET);
    printf("    }\n\n");

    printf("    export const enum SockType {\n");
    DEC(SOCK_STREAM, SOCK_STREAM);
    DEC(SOCK_DGRAM, SOCK_DGRAM);
    printf("    }\n\n");

    printf("    export const enum Protocol {\n");
    DEC(IPPROTO_TCP, IPPROTO_TCP);
    DEC(IPPROTO_UDP, IPPROTO_UDP);
    printf("    }\n\n");

    printf("    export const enum Shutdown {\n");
    DEC(SD_RECEIVE, SD_RECEIVE);
    DEC(SD_SEND, SD_SEND);
    DEC(SD_BOTH, SD_BOTH);
    printf("    }\n\n");

    printf("    export const enum FdEvent {\n");
    DEC(FD_READ, FD_READ);
    DEC(FD_WRITE, FD_WRITE);
    DEC(FD_CONNECT, FD_CONNECT);
    DEC(FD_CLOSE, FD_CLOSE);
    printf("    }\n\n");

    printf("}\n\n");

    /* wolfssl */
    printf("declare module \"wolfssl\" {\n\n");

    printf("    export const enum VerifyMode {\n");
    DEC(SSL_VERIFY_NONE, SSL_VERIFY_NONE);
    DEC(SSL_VERIFY_PEER, SSL_VERIFY_PEER);
    printf("    }\n\n");

    printf("    export const enum SniType {\n");
    DEC(WOLFSSL_SNI_HOST_NAME, WOLFSSL_SNI_HOST_NAME);
    printf("    }\n\n");

    printf("    export const enum FileType {\n");
    DEC(SSL_FILETYPE_PEM, SSL_FILETYPE_PEM);
    printf("    }\n\n");

    printf("    export const enum ReturnCode {\n");
    DEC(SSL_SUCCESS, SSL_SUCCESS);
    printf("    }\n\n");

    printf("    export const enum ErrorCode {\n");
    DEC(WOLFSSL_ERROR_WANT_READ, WOLFSSL_ERROR_WANT_READ);
    DEC(WOLFSSL_ERROR_WANT_WRITE, WOLFSSL_ERROR_WANT_WRITE);
    printf("    }\n\n");

    printf("}\n");
}

int main(void) {
    print_enums();
    return 0;
}
