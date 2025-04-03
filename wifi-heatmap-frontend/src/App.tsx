import React, { useState, useEffect, useRef } from 'react';
import { MapContainer, TileLayer, Marker, Popup, useMapEvents, ImageOverlay, useMap } from 'react-leaflet';
import L from 'leaflet'
import 'leaflet/dist/leaflet.css';
import 'leaflet.heat';
import { saveAs } from 'file-saver';
import './App.css';

interface Measurement {
  id: string;
  timestamp: string;
  dbm: number;
  lat: number;
  lng: number;
  floor: number;
  location: string;
  type: string;
}

interface Floor {
  id: number;
  name: string;
  mapPath: string;
}

const HeatmapLayer: React.FC<{ measurements: Measurement[] }> = ({ measurements }) => {
  const map = useMap();

  useEffect(() => {
    if (!map || measurements.length === 0) return;

    const heatPoints = measurements.map(m => {
      const intensity = Math.min(1, Math.max(0, (m.dbm + 90) / 60));
      return [m.lat, m.lng, intensity] as [number, number, number];
    });

    const heatLayer = L.heatLayer(heatPoints, { radius: 25, blur: 15, maxZoom: 17 });
    heatLayer.addTo(map);

    return () => {
      map.removeLayer(heatLayer);
    };
  }, [map, measurements]);

  return null;
};

const App: React.FC = () => {
  const [measurements, setMeasurements] = useState<Measurement[]>([]);
  const [floors, setFloors] = useState<Floor[]>([]);
  const [currentFloor, setCurrentFloor] = useState<number>(1);
  const [locationName, setLocationName] = useState<string>('');
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [mapBounds, setMapBounds] = useState<L.LatLngBoundsExpression>([[0, 0], [1000, 1000]]);
  const [newFloorName, setNewFloorName] = useState<string>('');
  const [measurementType, setMeasurementType] = useState<'location' | 'accesspoint'>('location');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const mapRef = useRef<L.Map>(null);

  useEffect(() => {
    fetchMeasurements();
    fetchFloors();
  }, [currentFloor]);

  const fetchMeasurements = async () => {
    setIsLoading(true);
    try {
      const response = await fetch(`http://localhost:8080/api/measurements?floor=${currentFloor}`);
      if (!response.ok) {
        throw new Error('Failed to fetch measurements');
      }
      const data: Measurement[] = await response.json();
      setMeasurements(data || []);
    } catch (error) {
      console.error('Error fetching measurements:', error);
      setMeasurements([]);
    } finally {
      setIsLoading(false);
    }
  };

  const fetchFloors = async () => {
    try {
      const response = await fetch('http://localhost:8080/api/floors');
      if (!response.ok) {
        throw new Error('Failed to fetch floors');
      }
      const data: Floor[] = await response.json();
      setFloors(data || []);
      if (data.length > 0 && !data.some(f => f.id === currentFloor)) {
        setCurrentFloor(data[0].id);
      }
    } catch (error) {
      console.error('Error fetching floors:', error);
      setFloors([]);
    }
  };

  const handleExport = async () => {
    try {
      const response = await fetch(`http://localhost:8080/api/export?floor=${currentFloor}`);
      if (!response.ok) {
        throw new Error('Export failed');
      }
      const blob = await response.blob();
      saveAs(blob, `wifi_heatmap_floor_${currentFloor}.csv`);
    } catch (error) {
      console.error('Export failed:', error);
      alert('Export failed: ' + (error as Error).message);
    }
  };

  const handleExportImage = async () => {
    if (!mapRef.current) return;

    try {
      const mapElement = mapRef.current.getContainer();
      const originalStyles: {[key: string]: string} = {};

      const elementsToHide = [
        '.leaflet-control-container',
        '.custom-marker'
      ];

      elementsToHide.forEach(selector => {
        const elements = mapElement.querySelectorAll(selector);
        elements.forEach(el => {
          originalStyles[el.id || selector] = (el as HTMLElement).style.display;
          (el as HTMLElement).style.display = 'none';
        });
      });

      measurements.forEach(m => {
        const isAccessPoint = m.type === 'accesspoint';
        const marker = L.marker([m.lat, m.lng], {
          icon: L.divIcon({
            className: 'export-marker',
            html: `
            <div class="export-marker-container">
              <div class="signal-marker-export" style="
                background: ${getColorForDbm(m.dbm)};
                opacity: 85%;
                width: ${isAccessPoint ? '30px' : '40px'};
                height: ${isAccessPoint ? '20px' : '20px'};
                display: flex;
                align-items: center;
                justify-content: center;
                box-shadow: 0 2px 5px rgba(0,0,0,0.3);
              ">
                <div style="
                  color: black;
                  font-weight: bold;
                  font-size: ${isAccessPoint ? '12px' : '10px'};
                  text-align: center;
                ">
                  ${isAccessPoint ? 'AP' : `${m.dbm}dBm`}
                </div>
              </div>
            </div>
          `,
            iconSize: isAccessPoint ? [30, 30] : [40, 40],
            iconAnchor: isAccessPoint ? [15, 15] : [20, 20]
          })
        }).addTo(mapRef.current!);

        (marker as any)._exportMarker = true;
      });

      await new Promise(resolve => setTimeout(resolve, 100));

      const html2canvas = (await import('html2canvas')).default;
      const canvas = await html2canvas(mapElement, {
        useCORS: true,
        logging: false,
      });

      canvas.toBlob((blob) => {
        if (blob) {
          saveAs(blob, `wifi_heatmap_floor_${currentFloor}_${new Date().toISOString().slice(0,10)}.png`);
        }
      }, 'image/png', 1);

      mapRef.current.eachLayer(layer => {
        if ((layer as any)._exportMarker) {
          mapRef.current!.removeLayer(layer);
        }
      });

      elementsToHide.forEach(selector => {
        const elements = mapElement.querySelectorAll(selector);
        elements.forEach(el => {
          const originalStyle = originalStyles[el.id || selector];
          if (originalStyle) {
            (el as HTMLElement).style.display = originalStyle;
          } else {
            (el as HTMLElement).style.removeProperty('display');
          }
        });
      });
    } catch (error) {
      console.error('Error exporting image:', error);
      alert('Failed to export image: ' + (error as Error).message);
    }
  };

  const handleAddFloor = async () => {
    if (!newFloorName.trim()) {
      alert('Please enter floor name');
      return;
    }

    try {
      const response = await fetch('http://localhost:8080/api/floors/add', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: newFloorName.trim()
        })
      });

      if (!response.ok) {
        throw new Error('Failed to add floor');
      }

      const newFloor = await response.json();
      setFloors(prev => [...prev, newFloor]);
      setNewFloorName('');
      setCurrentFloor(newFloor.id);
    } catch (error) {
      console.error('Error adding floor:', error);
      alert('Failed to add floor: ' + (error as Error).message);
    }
  };

  const handleUploadMap = async () => {
    if (!selectedFile || !currentFloor) {
      alert('Please select a file and floor');
      return;
    }

    const formData = new FormData();
    formData.append('map', selectedFile);

    try {
      setIsLoading(true);
      const response = await fetch(`http://localhost:8080/api/floors/upload-map/${currentFloor}`, {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        throw new Error(`Upload failed with status ${response.status}`);
      }

      const result = await response.json();

      await fetchFloors();

      const img = new Image();
      img.onload = () => {
        const newBounds: L.LatLngBoundsExpression = [
          [0, 0],
          [img.height, img.width]
        ];
        setMapBounds(newBounds);
        if (mapRef.current) {
          mapRef.current.fitBounds(newBounds);
          mapRef.current.invalidateSize();
        }
      };
      img.src = `http://localhost:8080${result.path}`;

      alert('Map uploaded successfully!');
    } catch (error) {
      console.error('Upload error:', error);
      alert('Upload failed: ' + (error as Error).message);
    } finally {
      setIsLoading(false);
      setSelectedFile(null);
    }
  };

  const handleAddMeasurement = async (lat: number, lng: number) => {
    const location = locationName.trim() || (measurementType === 'location' ? 'Location Point' : 'Access Point');

    try {
      const response = await fetch('http://localhost:8080/api/add', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          lat,
          lng,
          floor: currentFloor,
          location,
          type: measurementType
        })
      });

      if (!response.ok) {
        throw new Error('Failed to add measurement');
      }

      const newMeasurement = await response.json();
      setMeasurements(prev => [...prev, newMeasurement]);
      setLocationName('');
    } catch (error) {
      alert('Failed to add measurement: ' + (error as Error).message);
    }
  };

  const handleDeleteMeasurement = async (id: string) => {
    if (!window.confirm('Are you sure you want to delete this measurement?')) {
      return;
    }

    try {
      const response = await fetch(`http://localhost:8080/api/delete/${id}`, {
        method: 'DELETE'
      });

      if (!response.ok) {
        throw new Error('Failed to delete measurement');
      }

      setMeasurements(prev => prev.filter(m => m.id !== id));
    } catch (error) {
      alert('Failed to delete measurement: ' + (error as Error).message);
    }
  };

  const getCurrentFloorMap = (): string | undefined => {
    const floor = floors.find(f => f.id === currentFloor);
    return floor?.mapPath;
  };

  return (
      <div className="app-container">
        <div className="map-wrapper">
          {isLoading ? (
              <div className="loading">Loading map data...</div>
          ) : (
              <MapContainer
                  ref={mapRef}
                  center={[500, 500]}
                  zoom={1}
                  style={{ height: '100%', width: '100%' }}
                  crs={L.CRS.Simple}
                  bounds={mapBounds}
                  minZoom={0}
                  maxZoom={5}
                  maxBounds={mapBounds}
                  maxBoundsViscosity={1.0}
              >
                {getCurrentFloorMap() && (
                    <ImageOverlay
                        url={getCurrentFloorMap()!}
                        bounds={mapBounds}
                        zIndex={1}
                    />
                )}

                <HeatmapLayer measurements={measurements} />

                <MapClickHandler onMapClick={handleAddMeasurement} />

                {measurements.map((m) => (
                    <Marker
                        key={m.id}
                        position={[m.lat, m.lng]}
                        icon={L.divIcon({
                          className: `custom-marker ${m.type}`,
                          html: `
                    <div style="
                      background-color: ${getColorForDbm(m.dbm)};
                      width: ${m.type === 'accesspoint' ? '20px' : '30px'};
                      height: ${m.type === 'accesspoint' ? '20px' : '30px'};
                      border-radius: ${m.type === 'accesspoint' ? '3px' : '50%'};
                      display: flex;
                      align-items: center;
                      justify-content: center;
                      color: black;
                      font-weight: bold;
                      font-size: 10px;
                      box-shadow: 0 0 5px rgba(0,0,0,0.5);
                    ">
                      ${m.type === 'accesspoint' ? 'AP' : m.dbm}
                    </div>
                  `,
                          iconSize: m.type === 'accesspoint' ? [20, 20] : [30, 30],
                          iconAnchor: m.type === 'accesspoint' ? [10, 10] : [15, 15]
                        })}
                    >
                      <Popup>
                        <div>
                          <strong>{m.location}</strong>
                          <p>Type: {m.type === 'location' ? 'Location' : 'Access Point'}</p>
                          <p>Signal: {m.dbm} dBm</p>
                          <p>Time: {new Date(m.timestamp).toLocaleString()}</p>
                          <button
                              onClick={() => handleDeleteMeasurement(m.id)}
                              className="delete-button"
                          >
                            Delete
                          </button>
                        </div>
                      </Popup>
                    </Marker>
                ))}
              </MapContainer>
          )}
        </div>

        <div className="control-panel">
          <h1>Wi-Fi Heatmap Tracker</h1>

          <div className="control-section">
            <h3>Vyberte místo měření</h3>
            <select
                value={currentFloor}
                onChange={(e) => setCurrentFloor(Number(e.target.value))}
                disabled={isLoading}
            >
              {floors.map(floor => (
                  <option key={floor.id} value={floor.id}>{floor.name}</option>
              ))}
            </select>
          </div>

          <div className="control-section">
            <h3>Typ bodu</h3>
            <div className="measurement-type">
              <label>
                <input
                    type="radio"
                    name="measurementType"
                    checked={measurementType === 'location'}
                    onChange={() => setMeasurementType('location')}
                />
                Lokace
              </label>
              <label>
                <input
                    type="radio"
                    name="measurementType"
                    checked={measurementType === 'accesspoint'}
                    onChange={() => setMeasurementType('accesspoint')}
                />
                AP
              </label>
            </div>
          </div>

          <div className="control-section">
            <h3>Detaily bodu</h3>
            <input
                type="text"
                placeholder={measurementType === 'location' ? 'Jméno lokace (dobrovolné)' : 'Jméno AP (dobrovolné)'}
                value={locationName}
                onChange={(e) => setLocationName(e.target.value)}
                disabled={isLoading}
            />
          </div>

          <div className="control-section">
            <h3>Export</h3>
            <button
                onClick={handleExport}
                disabled={isLoading || measurements.length === 0}
            >
              {isLoading ? 'Loading...' : 'Export Data'}
            </button>

            <button
                onClick={handleExportImage}
                disabled={isLoading || measurements.length === 0}
            >
              Export mapy
            </button>
          </div>
        </div>
      </div>
  );
};

const MapClickHandler: React.FC<{
  onMapClick: (lat: number, lng: number) => void;
}> = ({ onMapClick }) => {
  useMapEvents({
    click: (e) => {
      onMapClick(e.latlng.lat, e.latlng.lng);
    }
  });
  return null;
};

const getColorForDbm = (dbm: number): string => {
  if (dbm >= -50) return '#00ff00';
  if (dbm >= -60) return '#7cfc00';
  if (dbm >= -70) return '#ffff00';
  if (dbm >= -80) return '#ffa500';
  return '#ff0000';
};

export default App;