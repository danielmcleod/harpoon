package main

import (
	"context"
	"net/http"
	"os"
	"strings"

	"github.com/segmentio/kafka-go"
)

// Consumes order events and emails customers through SendGrid.
func main() {
	r := kafka.NewReader(kafka.ReaderConfig{Brokers: []string{os.Getenv("KAFKA_BROKERS")}, Topic: "order-events", GroupID: "notifier"})
	for {
		m, err := r.ReadMessage(context.Background())
		if err != nil {
			continue
		}
		http.Post("https://api.sendgrid.com/v3/mail/send", "application/json", strings.NewReader(string(m.Value)))
	}
}
