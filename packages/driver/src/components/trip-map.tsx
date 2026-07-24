import React, { useEffect, useMemo, useRef } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import MapView, { Marker, Polyline, type LatLng } from 'react-native-maps';
import { colors } from '@/theme/colors';

interface TripMapProps {
  /** The driver's live position, drawn as a dot rather than a pin. */
  driver?: LatLng | null;
  pickup?: LatLng | null;
  dropoff?: LatLng | null;
  /** Remaining itinerary stops, drawn as small numbered markers in order. */
  stops?: LatLng[];
  /** Decoded driving route to draw (driver → current target). */
  routeCoords?: LatLng[] | null;
  /** Keep the camera glued to the driver (dashboard idle state). */
  followDriver?: boolean;
}

const EDGE_PADDING = { top: 80, right: 60, bottom: 80, left: 60 };

/**
 * The shared map for dashboard and trip screens. Renders whichever of
 * driver/pickup/dropoff it is given and keeps the camera framing them; with
 * `followDriver` it tracks the driver instead. Uses the platform's native map
 * (Apple Maps on iOS, Google on Android via the key in app.config.js).
 */
export function TripMap({ driver, pickup, dropoff, stops, routeCoords, followDriver = false }: TripMapProps) {
  const mapRef = useRef<MapView>(null);

  const points = useMemo(
    () => [driver, pickup, dropoff, ...(stops ?? [])].filter((p): p is LatLng => p != null),
    [driver, pickup, dropoff, stops]
  );

  useEffect(() => {
    const map = mapRef.current;
    if (!map || points.length === 0) return;

    if (followDriver && driver) {
      map.animateCamera({ center: driver, zoom: 15 }, { duration: 500 });
    } else if (routeCoords && routeCoords.length >= 2) {
      // Frame the whole remaining route plus its endpoints.
      map.fitToCoordinates([...routeCoords, ...points], {
        edgePadding: EDGE_PADDING,
        animated: true,
      });
    } else if (points.length >= 2) {
      map.fitToCoordinates(points, { edgePadding: EDGE_PADDING, animated: true });
    } else {
      map.animateCamera({ center: points[0]!, zoom: 15 }, { duration: 500 });
    }
  }, [driver, pickup, dropoff, followDriver, points, routeCoords]);

  // No real coordinate yet → an honest waiting state, never a fake city.
  if (points.length === 0) {
    return (
      <View style={styles.waiting} accessibilityLabel="Waiting for your location">
        <ActivityIndicator color={colors.textSecondary} />
        <Text style={styles.waitingText}>Waiting for your location…</Text>
      </View>
    );
  }

  return (
    <MapView
      ref={mapRef}
      style={StyleSheet.absoluteFill}
      initialRegion={{ ...points[0]!, latitudeDelta: 0.02, longitudeDelta: 0.02 }}
      showsCompass={false}
      toolbarEnabled={false}
      pitchEnabled={false}
      rotateEnabled={false}
    >
      {routeCoords && routeCoords.length >= 2 ? (
        <>
          {/* Cased route: white under-stroke + ink line, matching the rider app. */}
          <Polyline coordinates={routeCoords} strokeWidth={8} strokeColor={colors.white} />
          <Polyline coordinates={routeCoords} strokeWidth={4} strokeColor={colors.primary} />
        </>
      ) : null}
      {driver ? (
        <Marker coordinate={driver} anchor={{ x: 0.5, y: 0.5 }} tracksViewChanges={false}>
          <View style={styles.driverDotOuter}>
            <View style={styles.driverDotInner} />
          </View>
        </Marker>
      ) : null}
      {pickup ? <Marker coordinate={pickup} title="Pickup" pinColor={colors.accent} /> : null}
      {dropoff ? <Marker coordinate={dropoff} title="Dropoff" pinColor={colors.primary} /> : null}
      {stops?.map((stop, index) => (
        <Marker
          key={`stop-${index}-${stop.latitude}-${stop.longitude}`}
          coordinate={stop}
          anchor={{ x: 0.5, y: 0.5 }}
          tracksViewChanges={false}
        >
          <View style={styles.stopMarker}>
            <Text style={styles.stopMarkerText}>{index + 1}</Text>
          </View>
        </Marker>
      ))}
    </MapView>
  );
}

const styles = StyleSheet.create({
  waiting: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    backgroundColor: colors.background,
  },
  waitingText: { fontSize: 13, color: colors.textSecondary },
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
  stopMarker: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: colors.white,
    borderWidth: 1.5,
    borderColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: colors.black,
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.2,
    shadowRadius: 2,
    elevation: 3,
  },
  stopMarkerText: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.primary,
  },
});
