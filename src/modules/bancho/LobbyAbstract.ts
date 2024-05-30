import { LobbyInterface } from "./LobbyInterface";
abstract class LobbyAbstract implements LobbyInterface{
    name: string;
    settings: { maxPlayers: number; password: string; gameRule: number; teamMode: number };
    players: string[];
    refs: string[];

    connect(): Promise<void> {
        return Promise.resolve(undefined);
    }

    exit(): Promise<void> {
        return Promise.resolve(undefined);
    }

    inviteAll(): Promise<void> {
        return Promise.resolve(undefined);
    }

    join(): Promise<void> {
        return Promise.resolve(undefined);
    }

    leave(): Promise<void> {
        return Promise.resolve(undefined);
    }

}