package main

import (
	"encoding/binary"
	"fmt"
	"os"
)

func main() {
	if len(os.Args) < 3 {
		fmt.Println("Usage: go run gen_ico.go input.png output.ico")
		return
	}

	inputPath := os.Args[1]
	outputPath := os.Args[2]

	pngData, err := os.ReadFile(inputPath)
	if err != nil {
		fmt.Printf("Error reading PNG: %v\n", err)
		return
	}

	icoFile, err := os.Create(outputPath)
	if err != nil {
		fmt.Printf("Error creating ICO: %v\n", err)
		return
	}
	defer icoFile.Close()

	// ICO Header
	binary.Write(icoFile, binary.LittleEndian, uint16(0)) // Reserved
	binary.Write(icoFile, binary.LittleEndian, uint16(1)) // Type (1 for Icon)
	binary.Write(icoFile, binary.LittleEndian, uint16(1)) // Count (1 image)

	// Directory Entry
	// Since it's a PNG, we can use 256x256 as 0,0
	icoFile.Write([]byte{0, 0, 0, 0, 1, 0, 32, 0}) // Width, Height, Colors, Reserved, Planes, BPP
	binary.Write(icoFile, binary.LittleEndian, uint32(len(pngData))) // Size
	binary.Write(icoFile, binary.LittleEndian, uint32(6+16))         // Offset

	// Image Data
	icoFile.Write(pngData)

	fmt.Println("ICO created successfully!")
}
