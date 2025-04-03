import "leaflet";
import "leaflet.heat";

declare module "leaflet" {
    function heatLayer(
        latlngs: Array<[number, number, number]>,
        options?: HeatMapOptions
    ): HeatLayer;

    interface HeatMapOptions {
        radius?: number;
        blur?: number;
        maxZoom?: number;
        minOpacity?: number;
        max?: number;
        gradient?: { [key: number]: string };
    }

    interface HeatLayer extends Layer {
        setOptions(options: HeatMapOptions): this;
        addLatLng(latlng: [number, number, number]): this;
        setLatLngs(latlngs: Array<[number, number, number]>): this;
    }
}