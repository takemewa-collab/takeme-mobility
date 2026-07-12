import React, { useEffect, useMemo, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import MapView, { Marker, type LatLng } from 'react-native-maps';
import { colors } from '@/theme/colors';

interface TripMapProps {
  /** The driver's live position, drawn as a dot rather than a pin. */
  driver?: LatLng | null;
  pickup?: LatLng | null;
  dropoff?: LatLng | null;
  /** Keep the camera glued to the driver (dashboard idle state). */
  followDriver?: boolean;
}

/** Downtown Seattle, shown only until the first real coordinate arrives. */
const FALLBACK_REGION = {
  latitude: 47.6062,
  longitude: -122.3321,
  latitudeDelta: 0.05,
  longitudeDelta: 0.05,
};

const EDGE_PADDING = { top: 80, right: 60, bottom: 80, left: 60 };

/**
 * The shared map for dashboard and trip screens. Renders whichever of
 * driver/pickup/dropoff it is given and keeps the camera framing them; with
 * `followDriver` it tracks the driver instead. Uses the platform's native map
 * (Apple Maps on iOS, Google on Android via the key in app.config.js).
 */
export function TripMap({ driver, pickup, dropoff, followDriver = false }: TripMapProps) {
  const mapRef = useRef<MapView>(null);

  const points = useMemo(
    () => [driver, pickup, dropoff].filter((p): p is LatLng => p != null),
    [driver, pickup, dropoff]
  );

  useEffect(() => {
    const map = mapRef.current;
    if (!map || points.length === 0) return;

    if (followDriver && driver) {
      map.animateCamera({ center: driver, zoom: 15 }, { duration: 500 });
    } else if (points.length >= 2) {
      map.fitToCoordinates(points, { edgePadding: EDGE_PADDING, animated: true });
    } else {
      map.animateCamera({ center: points[0]!, zoom: 15 }, { duration: 500 });
    }
  }, [driver, pickup, dropoff, followDriver, points]);

  return (
    <MapView
      ref={mapRef}
      style={StyleSheet.absoluteFill}
      initialRegion={
        points[0]
          ? { ...points[0], latitudeDelta: 0.02, longitudeDelta: 0.02 }
          : FALLBACK_REGION
      }
      showsCompass={false}
      toolbarEnabled={false}
      pitchEnabled={false}
      rotateEnabled={false}
    >
      {driver ? (
        <Marker coordinate={driver} anchor={{ x: 0.5, y: 0.5 }} tracksViewChanges={false}>
          <View style={styles.driverDotOuter}>
            <View style={styles.driverDotInner} />
          </View>
        </Marker>
      ) : null}
      {pickup ? <Marker coordinate={pickup} title="Pickup" pinColor={colors.accent} /> : null}
      {dropoff ? <Marker coordinate={dropoff} title="Dropoff" pinColor={colors.primary} /> : null}
    </MapView>
  );
}

const styles = StyleSheet.create({
  driverDotOuter: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.white,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: colors.black,
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.3,
    shadowRadius: 3,
    elevation: 4,
  },
  driverDotInner: {
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: colors.accent,
  },
});
