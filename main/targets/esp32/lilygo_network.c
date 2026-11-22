/* T-Internet-COM network access. Receiver callbacks run only in the burst
 * task; the HTTP task exchanges bounded requests with that task. */
#include "lilygo_network.h"
#include "burst_serial.h"
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
#include <stdarg.h>
#include "driver/gpio.h"
#include "esp_eth.h"
#include "esp_event.h"
#include "esp_http_server.h"
#include "esp_netif.h"
#include "esp_rom_crc.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "lwip/sockets.h"
#include "lwip/inet.h"
#include "lwip/fcntl.h"

#define TCP_PORT 7355
#define MAX_BINS 2048
#define FRAME_HEADER 28
#define FRAME_SIZE (FRAME_HEADER + MAX_BINS + 4)

struct lilygo_snapshot {
    unsigned frequency, rate, bins;
    int result;
    int refs;
    int64_t deadline;
    SemaphoreHandle_t complete;
    uint8_t frame[FRAME_SIZE];
    size_t written;
    char line[128];
    size_t line_used;
    bool header_done;
};

static QueueHandle_t requests;
static portMUX_TYPE request_lock = portMUX_INITIALIZER_UNLOCKED;
static lilygo_snapshot_t *current;
static int listener = -1, client = -1;
static unsigned generation;
static esp_netif_t *eth_netif;

bool lilygo_network_command(const char *line) {
    if (strcmp(line, "NET?")) return false;
    char reply[96];
    esp_netif_ip_info_t ip;
    if (eth_netif && esp_netif_is_netif_up(eth_netif) &&
        esp_netif_get_ip_info(eth_netif, &ip) == ESP_OK && ip.ip.addr)
        snprintf(reply, sizeof(reply), "NET " IPSTR " TCP 7355 HTTP 80\n", IP2STR(&ip.ip));
    else
        snprintf(reply, sizeof(reply), "NET unavailable\n");
    burst_serial_send(reply, strlen(reply));
    return true;
}

static void release_request(lilygo_snapshot_t *r) {
    portENTER_CRITICAL(&request_lock);
    int refs = --r->refs;
    portEXIT_CRITICAL(&request_lock);
    if (!refs) {
        vSemaphoreDelete(r->complete);
        free(r);
    }
}

static void drop_client(void) {
    if (client >= 0) {
        close(client);
        client = -1;
        generation++;
    }
}
unsigned lilygo_tcp_generation(void) { return generation; }
bool lilygo_tcp_connected(void) { return client >= 0; }

void lilygo_tcp_poll(void) {
    if (listener < 0) return;
    int fd = accept(listener, NULL, NULL);
    if (fd < 0) return;
    if (client >= 0 || fcntl(fd, F_SETFL, O_NONBLOCK) < 0) {
        close(fd);
        return;
    }
    client = fd;
    generation++;
}

int lilygo_tcp_read(void *data, size_t size) {
    if (client < 0) return 0;
    int n = recv(client, data, size, MSG_DONTWAIT);
    if (n > 0) return n;
    if (n == 0 || (errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR)) drop_client();
    return 0;
}

int lilygo_tcp_write(const void *data, size_t size) {
    if (client < 0) return -1;
    int n = send(client, data, size, MSG_DONTWAIT);
    if (n >= 0) return n;
    if (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR) return 0;
    drop_client();
    return -1;
}

lilygo_snapshot_t *lilygo_snapshot_take(void) {
    lilygo_snapshot_t *r = NULL;
    if (requests) xQueueReceive(requests, &r, 0);
    return r;
}

size_t lilygo_snapshot_write(const void *data, size_t size) {
    if (!current) return 0;
    const uint8_t *p = data;
    for (size_t i = 0; i < size; i++) {
        if (!current->header_done) {
            if (current->line_used < sizeof(current->line) - 1)
                current->line[current->line_used++] = (char)p[i];
            if (p[i] == '\n') current->header_done = true;
        } else if (current->written < FRAME_HEADER + current->bins + 4) {
            current->frame[current->written++] = p[i];
        }
    }
    return size;
}
bool lilygo_snapshot_done(void) {
    return current && current->written >= FRAME_HEADER + current->bins + 4;
}

void lilygo_snapshot_run(lilygo_snapshot_t *r, void (*handle)(char *), bool busy) {
    r->result = 503;
    if (busy) {
        r->result = 409;
    } else if (esp_timer_get_time() < r->deadline) {
        char command[80];
        current = r;
        snprintf(command, sizeof(command), "FREQ %u", r->frequency);
        handle(command);
        if (r->header_done && !strcmp(r->line, "OK\n")) {
            r->header_done = false;
            r->line_used = 0;
            memset(r->line, 0, sizeof(r->line));
            snprintf(command, sizeof(command), "SPEC 1 1 1 0 %u %u", r->rate, r->bins);
            handle(command);
            size_t end = FRAME_HEADER + r->bins;
            uint32_t crc = (uint32_t)r->frame[end] | ((uint32_t)r->frame[end + 1] << 8) |
                           ((uint32_t)r->frame[end + 2] << 16) | ((uint32_t)r->frame[end + 3] << 24);
            if (lilygo_snapshot_done() && !strncmp(r->line, "SPEC ", 5) &&
                !memcmp(r->frame, "SPC1", 4) && esp_rom_crc32_le(0, r->frame, end) == crc)
                r->result = 200;
        }
        current = NULL;
    }
    xSemaphoreGive(r->complete);
    release_request(r);
}

static esp_err_t json_error(httpd_req_t *req, const char *status, const char *error) {
    char body[64];
    httpd_resp_set_status(req, status);
    httpd_resp_set_type(req, "application/json");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    snprintf(body, sizeof(body), "{\"error\":\"%s\"}", error);
    return httpd_resp_sendstr(req, body);
}

static bool number(const char *text, unsigned *out) {
    if (!*text) return false;
    unsigned value = 0;
    for (const char *p = text; *p; p++) {
        if (!isdigit((unsigned char)*p) || value > 10000) return false;
        value = value * 10 + (unsigned)(*p - '0');
    }
    *out = value;
    return true;
}

static bool allowed_request(httpd_req_t *req) {
    char header[128], origin[160], host[128], expected[160];
    if (httpd_req_get_hdr_value_str(req, "X-ESP-SDR", header, sizeof(header)) != ESP_OK ||
        strcmp(header, "1")) return false;
    if (!httpd_req_get_hdr_value_len(req, "Origin")) return true;
    if (httpd_req_get_hdr_value_str(req, "Origin", origin, sizeof(origin)) != ESP_OK ||
        httpd_req_get_hdr_value_str(req, "Host", host, sizeof(host)) != ESP_OK) return false;
    snprintf(expected, sizeof(expected), "http://%s", host);
    return !strcmp(origin, expected);
}

static bool append_json(char *buffer, size_t capacity, size_t *used, const char *format, ...) {
    if (*used >= capacity) return false;
    va_list args;
    va_start(args, format);
    int n = vsnprintf(buffer + *used, capacity - *used, format, args);
    va_end(args);
    if (n < 0 || (size_t)n >= capacity - *used) return false;
    *used += (size_t)n;
    return true;
}

static esp_err_t snapshot_handler(httpd_req_t *req) {
    if (!allowed_request(req)) return json_error(req, "403 Forbidden", "forbidden");
    char query[128], value[24];
    unsigned freq, rate, bins;
    if (httpd_req_get_url_query_str(req, query, sizeof(query)) != ESP_OK ||
        httpd_query_key_value(query, "freq", value, sizeof(value)) != ESP_OK || !number(value, &freq) ||
        httpd_query_key_value(query, "rate", value, sizeof(value)) != ESP_OK || !number(value, &rate) ||
        httpd_query_key_value(query, "bins", value, sizeof(value)) != ESP_OK || !number(value, &bins) ||
        freq < 100 || freq > 6000 || (rate != 0 && rate != 1 && rate != 6) ||
        (bins != 256 && bins != 512 && bins != 1024 && bins != 2048))
        return json_error(req, "400 Bad Request", "invalid_args");
    lilygo_snapshot_t *r = calloc(1, sizeof(*r));
    if (!r) return json_error(req, "503 Service Unavailable", "unavailable");
    r->complete = xSemaphoreCreateBinary();
    if (!r->complete) {
        free(r);
        return json_error(req, "503 Service Unavailable", "unavailable");
    }
    r->frequency = freq;
    r->rate = rate;
    r->bins = bins;
    r->deadline = esp_timer_get_time() + 3000000;
    r->refs = 2;
    if (!requests || xQueueSend(requests, &r, 0) != pdTRUE) {
        release_request(r);
        release_request(r);
        return json_error(req, "503 Service Unavailable", "unavailable");
    }
    if (xSemaphoreTake(r->complete, pdMS_TO_TICKS(3000)) != pdTRUE) {
        release_request(r);
        return json_error(req, "503 Service Unavailable", "unavailable");
    }
    if (r->result != 200) {
        int result = r->result;
        release_request(r);
        return json_error(req, result == 409 ? "409 Conflict" : "503 Service Unavailable",
                          result == 409 ? "busy" : "unavailable");
    }
    size_t capacity = bins * 4 + 192;
    char *body = malloc(capacity);
    if (!body) {
        release_request(r);
        return json_error(req, "503 Service Unavailable", "unavailable");
    }
    unsigned hz = rate == 0 ? 80000000 : rate == 1 ? 40000000 : 16000000;
    size_t used = 0;
    bool formatted = append_json(body, capacity, &used,
                                 "{\"frequency_mhz\":%u,\"sample_rate_hz\":%u,\"bins\":%u,\"gain\":%u,\"flags\":%u,\"power\":[",
                                 freq, hz, bins, r->frame[23], r->frame[22]);
    for (unsigned i = 0; i < bins; i++)
        formatted = formatted && append_json(body, capacity, &used, "%s%u", i ? "," : "",
                                              r->frame[FRAME_HEADER + i]);
    formatted = formatted && append_json(body, capacity, &used, "]}");
    release_request(r);
    if (!formatted) {
        free(body);
        return json_error(req, "503 Service Unavailable", "unavailable");
    }
    httpd_resp_set_type(req, "application/json");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    esp_err_t result = httpd_resp_sendstr(req, body);
    free(body);
    return result;
}

extern const char viewer_index[] asm("_binary_index_html_start");
extern const char viewer_css[] asm("_binary_viewer_css_start");
extern const char viewer_spectrum[] asm("_binary_spectrum_js_start");
extern const char viewer_js[] asm("_binary_viewer_js_start");

typedef struct {
    const char *content;
    const char *type;
} viewer_asset_t;
static const viewer_asset_t assets[] = {
    {viewer_index, "text/html; charset=utf-8"},
    {viewer_css, "text/css; charset=utf-8"},
    {viewer_spectrum, "text/javascript; charset=utf-8"},
    {viewer_js, "text/javascript; charset=utf-8"},
};

static esp_err_t asset_handler(httpd_req_t *req) {
    const viewer_asset_t *asset = req->user_ctx;
    httpd_resp_set_type(req, asset->type);
    httpd_resp_set_hdr(req, "X-Frame-Options", "DENY");
    httpd_resp_set_hdr(req, "Content-Security-Policy",
                       "default-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    httpd_resp_set_hdr(req, "X-Content-Type-Options", "nosniff");
    return httpd_resp_sendstr(req, asset->content);
}

void lilygo_network_init(void) {
    requests = xQueueCreate(1, sizeof(lilygo_snapshot_t *));
    if (!requests || esp_netif_init() != ESP_OK) return;
    esp_netif_config_t netif_config = ESP_NETIF_DEFAULT_ETH();
    esp_netif_t *netif = esp_netif_new(&netif_config);
    if (!netif) return;
    gpio_config_t power = {.pin_bit_mask = 1ULL << 4, .mode = GPIO_MODE_OUTPUT};
    if (gpio_config(&power) != ESP_OK || gpio_set_level(4, 1) != ESP_OK) return;
    vTaskDelay(pdMS_TO_TICKS(200));
    eth_mac_config_t mac_config = ETH_MAC_DEFAULT_CONFIG();
    eth_esp32_emac_config_t emac_config = ETH_ESP32_EMAC_DEFAULT_CONFIG();
    emac_config.smi_gpio.mdc_num = 23;
    emac_config.smi_gpio.mdio_num = 18;
    emac_config.clock_config.rmii.clock_mode = EMAC_CLK_OUT;
    emac_config.clock_config.rmii.clock_gpio = 0;
    eth_phy_config_t phy_config = ETH_PHY_DEFAULT_CONFIG();
    phy_config.phy_addr = 0;
    phy_config.reset_gpio_num = 5;
    esp_eth_mac_t *mac = esp_eth_mac_new_esp32(&emac_config, &mac_config);
    esp_eth_phy_t *phy = esp_eth_phy_new_lan87xx(&phy_config);
    if (!mac || !phy) return;
    esp_eth_config_t config = ETH_DEFAULT_CONFIG(mac, phy);
    esp_eth_handle_t eth;
    if (esp_eth_driver_install(&config, &eth) != ESP_OK) return;
    esp_eth_netif_glue_handle_t glue = esp_eth_new_netif_glue(eth);
    if (!glue || esp_netif_attach(netif, glue) != ESP_OK || esp_eth_start(eth) != ESP_OK) return;
    eth_netif = netif;
    listener = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (listener >= 0) {
        struct sockaddr_in addr = {.sin_family = AF_INET, .sin_port = htons(TCP_PORT),
                                   .sin_addr.s_addr = htonl(INADDR_ANY)};
        int reuse = 1;
        setsockopt(listener, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse));
        if (fcntl(listener, F_SETFL, O_NONBLOCK) < 0 || bind(listener, (void *)&addr, sizeof(addr)) < 0 ||
            listen(listener, 2) < 0) {
            close(listener);
            listener = -1;
        }
    }
    httpd_handle_t http = NULL;
    httpd_config_t http_config = HTTPD_DEFAULT_CONFIG();
    http_config.stack_size = 6144;
    if (httpd_start(&http, &http_config) == ESP_OK) {
        httpd_uri_t uri = {.uri = "/api/spectrum", .method = HTTP_GET, .handler = snapshot_handler};
        httpd_register_uri_handler(http, &uri);
        const char *paths[] = {"/", "/index.html", "/viewer.css", "/spectrum.js", "/viewer.js"};
        const unsigned indexes[] = {0, 0, 1, 2, 3};
        for (unsigned i = 0; i < sizeof(indexes) / sizeof(indexes[0]); i++) {
            httpd_uri_t asset = {.uri = paths[i], .method = HTTP_GET, .handler = asset_handler,
                                 .user_ctx = (void *)&assets[indexes[i]]};
            httpd_register_uri_handler(http, &asset);
        }
    }
}
