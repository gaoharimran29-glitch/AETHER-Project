import heapq
import time

class EventQueue:
    def __init__(self):
        self.queue = []

    def schedule_event(self, timestamp, event_type, data):
        """
        timestamp: epoch time jab event execute hona chahiye
        event_type: 'MANEUVER', 'LOS_CHECK', 'STATION_KEEPING'
        """
        heapq.heappush(self.queue, (timestamp, event_type, data))

    def get_pending_events(self, current_time):
        pending = []
        while self.queue and self.queue[0][0] <= current_time:
            pending.append(heapq.heappop(self.queue))
        return pending

# Global instance
event_scheduler = EventQueue()