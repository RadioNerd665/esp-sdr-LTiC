"""Host checks of the production LilyGO snapshot adapter and HTTP guards."""
from pathlib import Path
import os
import shutil
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]


def compile_and_run(program, flags):
    fd = os.memfd_create("lilygo-test")
    try:
        executable = f"/proc/self/fd/{fd}"
        subprocess.run(
            ["cc", "-pipe", "-std=c11", "-Wall", "-Wextra", *flags,
             "-x", "c", "-", "-o", executable],
            input=program, text=True, check=True, pass_fds=(fd,),
            env={**os.environ, "TMPDIR": str(ROOT)},
        )
        subprocess.run([executable], check=True, pass_fds=(fd,))
    finally:
        os.close(fd)


@unittest.skipUnless(hasattr(os, "memfd_create"), "Linux memfd unavailable")
class LilygoNetwork(unittest.TestCase):
    @unittest.skipUnless(shutil.which("cc"), "Host C compiler unavailable")
    def test_board_gpio_exclusions(self):
        source = (ROOT / "main/common/burst_gpio.c").read_text()
        exclusions = source[source.index("#define PIN(n)"):source.index("void burst_gpio_init(")]
        harness = r'''
#include <assert.h>
#include <stdint.h>
#define SOC_GPIO_PIN_COUNT 40
#define SOC_USB_SERIAL_JTAG_SUPPORTED 0
#define CONFIG_IDF_TARGET_ESP32 1
#define CONFIG_ESP_SDR_UART_ENABLED 1
#define CONFIG_ESP_SDR_UART_TX_PIN 1
#define CONFIG_ESP_SDR_UART_RX_PIN 3
'''
        checks = r'''
int main(void) {
    uint64_t mask=excluded_pins();
    unsigned board[]={0,2,4,5,12,13,14,15,18,19,21,22,23,25,26,27,32,33};
    for(unsigned i=0;i<sizeof(board)/sizeof(board[0]);i++) {
#if CONFIG_ESP_SDR_LILYGO
        assert(mask & PIN(board[i]));
#else
        assert(!(mask & PIN(board[i])));
#endif
    }
    assert((mask & PIN(1)) && (mask & PIN(3)) && (mask & PIN(6)) && (mask & PIN(17)));
}
'''
        for enabled in (0, 1):
            compile_and_run(harness + exclusions + checks,
                            ["-Wno-unused-variable", f"-DCONFIG_ESP_SDR_LILYGO={enabled}"])

    @unittest.skipUnless(shutil.which("cc"), "Host C compiler unavailable")
    def test_snapshot_and_http_guards(self):
        source = (ROOT / "main/targets/esp32/lilygo_network.c").read_text()
        adapter = source[source.index("size_t lilygo_snapshot_write("):source.index("static esp_err_t json_error(")]
        guards = source[source.index("static bool number("):source.index("static esp_err_t snapshot_handler(")]
        stub = r'''
#include <assert.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdarg.h>
#include <string.h>
#include <ctype.h>
#define FRAME_HEADER 28
#define FRAME_SIZE (FRAME_HEADER + 2048 + 4)
#define ESP_OK 0
typedef struct {
    unsigned frequency, rate, bins;
    int result, refs;
    int64_t deadline;
    void *complete;
    uint8_t frame[FRAME_SIZE];
    size_t written;
    char line[128];
    size_t line_used;
    bool header_done;
} lilygo_snapshot_t;
static lilygo_snapshot_t *current;
static unsigned calls, completed;
static bool broken;
static int64_t esp_timer_get_time(void) { return 100; }
static void xSemaphoreGive(void *s) { completed++; }
static void release_request(lilygo_snapshot_t *r) { r->refs--; }
static uint32_t esp_rom_crc32_le(uint32_t c,const void *p,size_t n) { return 0x12345678; }
typedef struct { const char *header, *origin, *host; } httpd_req_t;
static const char *hdr(httpd_req_t *r, const char *name) {
    return !strcmp(name,"X-ESP-SDR") ? r->header : !strcmp(name,"Origin") ? r->origin : r->host;
}
static size_t httpd_req_get_hdr_value_len(httpd_req_t *r,const char *name) {
    const char *s=hdr(r,name); return s ? strlen(s) : 0;
}
static int httpd_req_get_hdr_value_str(httpd_req_t *r,const char *name,char *b,size_t n) {
    const char *s=hdr(r,name); if(!s || strlen(s)>=n) return -1; strcpy(b,s); return 0;
}
'''
        checks = r'''
static void command(char *line) {
    calls++;
    if (!strncmp(line,"FREQ ",5)) {
        assert(!strcmp(line,"FREQ 2412"));
        lilygo_snapshot_write("OK\n",3);
    } else {
        assert(!strcmp(line,"SPEC 1 1 1 0 6 256"));
        lilygo_snapshot_write("SPEC 256 16000000 256 2412\n",27);
        if (broken) return;
        uint8_t f[316]={0};
        memcpy(f,"SPC1",4); f[22]=8; f[23]=42; f[28]=17;
        f[284]=0x78; f[285]=0x56; f[286]=0x34; f[287]=0x12;
        lilygo_snapshot_write(f,12);
        assert(!lilygo_snapshot_done());
        lilygo_snapshot_write(f+12,276);
        assert(lilygo_snapshot_done());
        lilygo_snapshot_write("SPECEND 0\n",10);
    }
}
int main(void) {
    lilygo_snapshot_t r={.frequency=2412,.rate=6,.bins=256,.deadline=200,.refs=2};
    lilygo_snapshot_run(&r,command,false);
    assert(calls==2 && completed==1 && r.result==200 && r.refs==1);
    assert(r.frame[22]==8 && r.frame[23]==42 && r.frame[28]==17);
    r=(lilygo_snapshot_t){.frequency=2412,.rate=6,.bins=256,.deadline=200,.refs=2};
    lilygo_snapshot_run(&r,command,true);
    assert(r.result==409 && calls==2 && r.refs==1);
    r=(lilygo_snapshot_t){.frequency=2412,.rate=6,.bins=256,.deadline=99,.refs=2};
    lilygo_snapshot_run(&r,command,false);
    assert(r.result==503 && calls==2);
    broken=true;
    r=(lilygo_snapshot_t){.frequency=2412,.rate=6,.bins=256,.deadline=200,.refs=2};
    lilygo_snapshot_run(&r,command,false);
    assert(r.result==503 && calls==4);
    unsigned v;
    assert(number("6000",&v) && v==6000);
    assert(!number("",&v) && !number("-1",&v) && !number("2x",&v) && !number("999999999",&v));
    httpd_req_t q={.header="1",.host="192.0.2.1"};
    assert(allowed_request(&q));
    q.origin="http://192.0.2.1"; assert(allowed_request(&q));
    q.origin="https://evil.example"; assert(!allowed_request(&q));
    q.origin=NULL; q.header=NULL; assert(!allowed_request(&q));
    q.header="0"; assert(!allowed_request(&q));
    char buffer[5]; size_t used=0;
    assert(append_json(buffer,sizeof(buffer),&used,"%s","1234") && used==4);
    assert(!append_json(buffer,sizeof(buffer),&used,"%s","x") && used==4);
    return 0;
}
'''
        compile_and_run(stub + adapter + guards + checks,
                        ["-Wno-unused-parameter", "-fsanitize=undefined"])

    @unittest.skipUnless(shutil.which("cc"), "Host C compiler unavailable")
    def test_receiver_lease_and_disconnect(self):
        source = (ROOT / "main/common/burst_serial.c").read_text()
        serve = source[source.index("static void serve_reply("):]
        harness = r'''
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include <setjmp.h>
#define CONFIG_ESP_SDR_LILYGO 1
#define BURST_SERIAL_UART 1
#define BURST_SERIAL_TCP 2
#define BURST_SERIAL_HTTP 3
typedef struct { int unused; } lilygo_snapshot_t;
static lilygo_snapshot_t request;
static struct { int used; } input[4];
static int active_port, index_, handled, busy_http, free_http, baud, replies;
static unsigned generation;
static jmp_buf done;
static int64_t esp_timer_get_time(void) { return 100; }
static void lilygo_tcp_poll(void) {
    if(index_==1) generation=1;
    if(index_==6) generation=2;
}
static unsigned lilygo_tcp_generation(void) { return generation; }
static lilygo_snapshot_t *lilygo_snapshot_take(void) {
    if(index_==2 || index_==4) return &request;
    return NULL;
}
static void lilygo_snapshot_run(lilygo_snapshot_t *r,void (*handle)(char *),bool busy) {
    assert(r==&request); if(busy) busy_http++; else free_http++; index_++;
}
static int burst_serial_poll_line(char *line,size_t size) {
    if(index_==8) longjmp(done,1);
    if(index_==0 || index_==3 || index_==6 || index_==7) active_port=BURST_SERIAL_UART;
    else active_port=BURST_SERIAL_TCP;
    strcpy(line,index_==3 ? "RELEASE" : index_==7 ? "BAUD?" : "INFO");
    index_++; return 1;
}
static int burst_serial_port(void) { return active_port; }
static bool burst_serial_send(const void *p,size_t n) {
    if(replies==0) assert(n==9 && !memcmp(p,"ERR busy\n",9));
    if(replies==1) assert(n==3 && !memcmp(p,"OK\n",3));
    replies++; return true;
}
static bool baud_command(const char *line) {
    if(!strcmp(line,"BAUD?")) { baud++; return true; } return false;
}
static void vTaskDelay(int ticks) {}
static void handle(char *line) { assert(!strcmp(line,"INFO")); handled++; }
'''
        checks = r'''
int main(void) {
    if(!setjmp(done)) burst_serial_serve(handle);
    assert(handled==3 && busy_http==1 && free_http==1 && baud==1 && replies==2);
}
'''
        compile_and_run(harness + serve + checks,
                        ["-Wno-unused-parameter", "-fsanitize=undefined"])


if __name__ == "__main__":
    unittest.main()
