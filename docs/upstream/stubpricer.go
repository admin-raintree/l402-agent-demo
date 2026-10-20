//go:build ignore

// stubpricer is a minimal pricesrpc server that returns a fixed price for
// every path. Test fixture only. Build it from an Aperture checkout:
//
//	mkdir cmd/stubpricer && cp stubpricer.go cmd/stubpricer/main.go
//	go build -o stubpricer ./cmd/stubpricer
//	./stubpricer -listen 127.0.0.1:8790 -price 25
package main

import (
	"context"
	"flag"
	"log"
	"net"

	"github.com/lightninglabs/aperture/pricesrpc"
	"google.golang.org/grpc"
)

type server struct {
	pricesrpc.UnimplementedPricesServer
	price int64
}

func (s *server) GetPrice(_ context.Context,
	req *pricesrpc.GetPriceRequest) (*pricesrpc.GetPriceResponse, error) {

	log.Printf("GetPrice path=%s -> %d sats", req.Path, s.price)
	return &pricesrpc.GetPriceResponse{PriceSats: s.price}, nil
}

func main() {
	addr := flag.String("listen", "127.0.0.1:8790", "listen address")
	price := flag.Int64("price", 25, "price in sats")
	flag.Parse()
	lis, err := net.Listen("tcp", *addr)
	if err != nil {
		log.Fatal(err)
	}
	g := grpc.NewServer()
	pricesrpc.RegisterPricesServer(g, &server{price: *price})
	log.Printf("stub pricer on %s at %d sats", *addr, *price)
	log.Fatal(g.Serve(lis))
}
