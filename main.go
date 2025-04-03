package main

import (
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math/rand"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const baseURL = "http://localhost:8080"

var (
	measurements []Measurement
	floors       = make(map[int]Floor)
	mutex        sync.Mutex
	floorsLock   sync.RWMutex
)

const (
	measurementsFile = "measurements.json"
	floorsFile       = "floors.json"
)

type Measurement struct {
	ID        string    `json:"id"`
	Timestamp time.Time `json:"timestamp"`
	Dbm       int       `json:"dbm"`
	Lat       float64   `json:"lat"`
	Lng       float64   `json:"lng"`
	Floor     int       `json:"floor"`
	Location  string    `json:"location"`
	Type      string    `json:"type"`
}

type MeasurementRequest struct {
	Lat      float64 `json:"lat"`
	Lng      float64 `json:"lng"`
	Floor    int     `json:"floor"`
	Location string  `json:"location"`
	Type     string  `json:"type"`
	Samples  int     `json:"samples"`
	Interval int     `json:"interval"`
}

type Floor struct {
	ID      int    `json:"id"`
	Name    string `json:"name"`
	MapPath string `json:"mapPath"`
}

func main() {
	if err := os.MkdirAll("uploads", 0755); err != nil {
		log.Fatal("Failed to create uploads directory:", err)
	}

	if err := loadData(); err != nil {
		log.Fatal("Failed to load data:", err)
	}

	if len(floors) == 0 {
		saveFloors()
	}

	corsMiddleware := func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Access-Control-Allow-Origin", "*")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")

			if r.Method == "OPTIONS" {
				w.WriteHeader(http.StatusOK)
				return
			}

			next.ServeHTTP(w, r)
		})
	}

	router := http.NewServeMux()
	router.HandleFunc("/api/measurements", getMeasurementsHandler)
	router.HandleFunc("/api/add", addMeasurementHandler)
	router.HandleFunc("/api/export", exportHandler)
	router.HandleFunc("/api/delete/", deleteMeasurementHandler)
	router.HandleFunc("/api/floors", floorsHandler)
	router.HandleFunc("/api/floors/add", addFloorHandler)
	router.HandleFunc("/api/floors/upload-map/", uploadMapHandler)
	router.HandleFunc("/uploads/", serveFileHandler)

	log.Println("Server running on port 8080...")
	log.Fatal(http.ListenAndServe(":8080", corsMiddleware(router)))
}

func loadData() error {
	if err := loadMeasurements(); err != nil {
		return fmt.Errorf("Failed to load measurements: %v", err)
	}

	if err := loadFloors(); err != nil {
		return fmt.Errorf("failed to load floors: %v", err)
	}

	return nil
}

func loadMeasurements() error {
	mutex.Lock()
	defer mutex.Unlock()

	data, err := os.ReadFile(measurementsFile)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}

	return json.Unmarshal(data, &measurements)
}

func loadFloors() error {
	mutex.Lock()
	defer mutex.Unlock()

	data, err := os.ReadFile(floorsFile)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}

	return json.Unmarshal(data, &floors)
}

func saveMeasurements() error {
	mutex.Lock()
	defer mutex.Unlock()

	data, err := json.MarshalIndent(measurements, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(measurementsFile, data, 0644)
}

func saveFloors() error {
	mutex.Lock()
	defer mutex.Unlock()

	data, err := json.MarshalIndent(floors, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(floorsFile, data, 0644)
}

func serveFileHandler(w http.ResponseWriter, r *http.Request) {
	requestedPath := r.URL.Path

	floorsLock.RLock()
	defer floorsLock.RUnlock()

	var filePath string
	for _, floor := range floors {
		if floor.MapPath == "" {
			continue
		}

		urlParts := strings.Split(floor.MapPath, baseURL)
		if len(urlParts) < 2 {
			continue
		}
		floorFilePath := urlParts[1]

		if floorFilePath == requestedPath {
			filePath = strings.TrimPrefix(floorFilePath, "/")
			break
		}
	}

	if filePath == "" {
		http.Error(w, "file not found in any floor map paths", http.StatusNotFound)
		return
	}

	if _, err := os.Stat(filePath); os.IsNotExist(err) {
		http.Error(w, "file not found on server", http.StatusNotFound)
		return
	}

	ext := filepath.Ext(filePath)
	switch ext {
	case ".png":
		w.Header().Set("Content-Type", "image/png")
	case ".jpg", ".jpeg":
		w.Header().Set("Content-Type", "image/jpeg")
	case ".gif":
		w.Header().Set("Content-Type", "image/gif")
	default:
		w.Header().Set("Content-Type", "application/octet-stream")
	}

	http.ServeFile(w, r, filePath)
}

func uploadMapHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	if err := r.ParseMultipartForm(10 << 20); err != nil {
		http.Error(w, "failed to parse multipart form", http.StatusBadRequest)
		return
	}

	floorID, err := strconv.Atoi(filepath.Base(r.URL.Path))
	if err != nil {
		http.Error(w, "invalid floor ID", http.StatusBadRequest)
		return
	}

	file, header, err := r.FormFile("map")
	if err != nil {
		http.Error(w, "filed to get file from form", http.StatusBadRequest)
		return
	}
	defer file.Close()

	if err := os.MkdirAll("uploads", os.ModePerm); err != nil {
		http.Error(w, "failed to create uploads directory", http.StatusInternalServerError)
		return
	}

	ext := filepath.Ext(header.Filename)
	newFilename := fmt.Sprintf("floor_%d_map%s", floorID, ext)
	filePath := filepath.Join("uploads", newFilename)

	out, err := os.Create(filePath)
	if err != nil {
		http.Error(w, "failed to create file on server", http.StatusInternalServerError)
		return
	}
	defer out.Close()

	if _, err := io.Copy(out, file); err != nil {
		http.Error(w, "failed to save file content", http.StatusInternalServerError)
		return
	}

	mutex.Lock()
	defer mutex.Unlock()

	if floor, exists := floors[floorID]; exists {
		floor.MapPath = fmt.Sprintf("/uploads/%s", newFilename)
		floors[floorID] = floor
		if err := saveFloors(); err != nil {
			http.Error(w, "failed to save floor data", http.StatusInternalServerError)
			return
		}
	} else {
		http.Error(w, "floor not found", http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"status": "success",
		"path":   floors[floorID].MapPath,
	})
}

func floorsHandler(w http.ResponseWriter, r *http.Request) {
	mutex.Lock()
	defer mutex.Unlock()

	var floorList []Floor
	for _, floor := range floors {
		floorList = append(floorList, floor)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(floorList)
}

func addFloorHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Name string `json:"name"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	mutex.Lock()
	defer mutex.Unlock()

	newID := 1
	for id := range floors {
		if id >= newID {
			newID = id + 1
		}
	}

	floors[newID] = Floor{
		ID:   newID,
		Name: req.Name,
	}
	saveFloors()

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(floors[newID])
}

func deleteMeasurementHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method == "OPTIONS" {
		w.WriteHeader(http.StatusOK)
		return
	}

	id := filepath.Base(r.URL.Path)
	if id == "" {
		http.Error(w, "ID is required", http.StatusBadRequest)
		return
	}

	mutex.Lock()
	found := false
	for i, m := range measurements {
		if m.ID == id {
			measurements = append(measurements[:i], measurements[i+1:]...)
			found = true
			break
		}
	}
	mutex.Unlock()

	if !found {
		http.Error(w, "Measurement not found", http.StatusNotFound)
		return
	}

	if err := saveMeasurements(); err != nil {
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"status": "deleted"})
}

func getMeasurementsHandler(w http.ResponseWriter, r *http.Request) {
	floorStr := r.URL.Query().Get("floor")
	floor, err := strconv.Atoi(floorStr)
	if err != nil {
		floor = 0
	}

	mutex.Lock()
	defer mutex.Unlock()

	var filtered []Measurement
	if floor > 0 {
		for _, m := range measurements {
			if m.Floor == floor {
				filtered = append(filtered, m)
			}
		}
	} else {
		filtered = measurements
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(filtered)
}

func addMeasurementHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method == "OPTIONS" {
		w.WriteHeader(http.StatusOK)
		return
	}

	var req MeasurementRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	if req.Type == "" {
		req.Type = "location"
	}
	if req.Samples <= 0 {
		req.Samples = 5
	}
	if req.Interval <= 0 {
		req.Interval = 500
	}

	var signalMeasurements []int
	for i := 0; i < req.Samples; i++ {
		signal, err := getWifiSignalDbm("wlp0s20f3")

		if err != nil {
			signal = -999
		}

		signalMeasurements = append(signalMeasurements, signal)
		time.Sleep(time.Duration(req.Interval) * time.Millisecond)
	}

	finalDbm := calculateMedian(signalMeasurements)

	record := Measurement{
		ID:        generateID(),
		Timestamp: time.Now(),
		Dbm:       finalDbm,
		Lat:       req.Lat,
		Lng:       req.Lng,
		Floor:     req.Floor,
		Location:  req.Location,
		Type:      req.Type,
	}

	mutex.Lock()
	measurements = append(measurements, record)
	mutex.Unlock()

	if err := saveMeasurements(); err != nil {
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(record)
}

func exportHandler(w http.ResponseWriter, r *http.Request) {
	floorStr := r.URL.Query().Get("floor")
	floor, err := strconv.Atoi(floorStr)
	if err != nil {
		floor = 0
	}

	mutex.Lock()
	defer mutex.Unlock()

	var filtered []Measurement
	if floor > 0 {
		for _, m := range measurements {
			if m.Floor == floor {
				filtered = append(filtered, m)
			}
		}
	} else {
		filtered = measurements
	}

	w.Header().Set("Content-Type", "text/csv")
	w.Header().Set("Content-Disposition", "attachment; filename=wifi_measurements.csv")

	csvWriter := csv.NewWriter(w)
	defer csvWriter.Flush()

	csvWriter.Write([]string{"id", "timestamp", "dbm", "lat", "lng", "floor", "location", "type"})

	for _, m := range filtered {
		csvWriter.Write([]string{
			m.ID,
			m.Timestamp.Format(time.RFC3339),
			strconv.Itoa(m.Dbm),
			strconv.FormatFloat(m.Lat, 'f', 6, 64),
			strconv.FormatFloat(m.Lng, 'f', 6, 64),
			strconv.Itoa(m.Floor),
			m.Location,
			m.Type,
		})
	}
}

func getWifiSignalDbm(interfaceName string) (int, error) {
	cmd := exec.Command("iw", "dev", interfaceName, "link")
	output, err := cmd.CombinedOutput()
	if err != nil {
		return 0, err
	}

	re := regexp.MustCompile(`signal:\s*(-?\d+)\s*dBm`)
	match := re.FindStringSubmatch(string(output))
	if len(match) < 2 {
		return 0, fmt.Errorf("signal not found")
	}

	return strconv.Atoi(match[1])
}

func generateID() string {
	const charset = "abcdefghijklmnopqrstuvwxyz0123456789"
	b := make([]byte, 8)
	for i := range b {
		b[i] = charset[rand.Intn(len(charset))]
	}
	return string(b)
}

func calculateMedian(values []int) int {
	sorted := make([]int, len(values))
	copy(sorted, values)
	sort.Ints(sorted)

	n := len(sorted)
	if n == 0 {
		return 0
	}

	var median int
	if n%2 == 1 {
		median = sorted[n/2]
	} else {
		median = (sorted[n/2-1] + sorted[n/2]) / 2
	}

	return median
}
