#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct lilygo_snapshot lilygo_snapshot_t;

void lilygo_network_init(void);
bool lilygo_network_command(const char *line);
void lilygo_tcp_poll(void);
unsigned lilygo_tcp_generation(void);
bool lilygo_tcp_connected(void);
int lilygo_tcp_read(void *data, size_t size);
int lilygo_tcp_write(const void *data, size_t size);
lilygo_snapshot_t *lilygo_snapshot_take(void);
void lilygo_snapshot_run(lilygo_snapshot_t *request, void (*handle)(char *), bool busy);
size_t lilygo_snapshot_write(const void *data, size_t size);
bool lilygo_snapshot_done(void);
